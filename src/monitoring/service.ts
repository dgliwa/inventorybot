import type { AdapterRegistry } from "../adapters/registry.js";
import { discoverRetailers } from "../discovery/discover.js";
import type { RetailerSearchClient } from "../discovery/types.js";
import { matchProductIdentity } from "../domain/product.js";
import { generateRetailerAdapter } from "../generation/generate-adapter.js";
import { validateRetailerAdapter } from "../generation/validate-adapter.js";
import { inspectRetailerStatic } from "../inspection/static.js";
import type { RetailerInspection } from "../inspection/types.js";
import { NotificationDispatcher } from "../notifications/dispatcher.js";
import type { NotificationChannel } from "../notifications/types.js";
import type { InventoryDatabase } from "../persistence/db.js";
import { SearchWatchService } from "../search-watches/service.js";
import type { DeterministicSearchClient, SearchWatchRunResult } from "../search-watches/types.js";
import { WatchService, type WatchLogRecord } from "../watches/service.js";
import { DomainConcurrencyLimiter } from "./concurrency.js";
import type { InventoryBotConfig } from "./config.js";

export type FastMonitorSummary = {
  watches: number;
  checkedTargets: number;
  watchFailures: number;
  notificationsRecommended: number;
  delivery: { claimed: number; sent: number; failed: number; terminal: number };
};

export type SearchMonitorSummary = {
  watchesConsidered: number;
  watchesRun: number;
  failures: number;
  newResults: number;
  notificationsRecommended: number;
  results: SearchWatchRunResult[];
  delivery: { claimed: number; sent: number; failed: number; terminal: number };
  dryRun?: true;
};

export type SlowMonitorSummary = {
  watchesConsidered: number;
  discoveries: number;
  candidatesFound: number;
  targetsInspected: number;
  adapterCandidatesGenerated: number;
  adapterCandidatesValidated: number;
  failures: number;
  dryRun?: true;
  preview?: { staleWatches: number; inspectableTargets: number };
};

type MonitorDependencies = {
  databaseFactory: () => InventoryDatabase;
  registry?: AdapterRegistry;
  registryFactory?: (database: InventoryDatabase) => AdapterRegistry;
  config: InventoryBotConfig;
  searchClient?: RetailerSearchClient;
  deterministicSearchClient: DeterministicSearchClient;
  notificationChannels?: ReadonlyMap<string, NotificationChannel>;
  inspect?: typeof inspectRetailerStatic;
  validate?: typeof validateRetailerAdapter;
  log?: (event: Record<string, unknown>) => void;
  now?: () => Date;
};

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /https?:\/\/[^\s]+/g,
    (value) => {
      try {
        const url = new URL(value);
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted-url]";
      }
    },
  );
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        await worker(values[index]);
      }
    }),
  );
}

export class InventoryMonitor {
  readonly #databaseFactory: () => InventoryDatabase;
  readonly #registryFactory: (database: InventoryDatabase) => AdapterRegistry;
  readonly #config: InventoryBotConfig;
  readonly #searchClient?: RetailerSearchClient;
  readonly #deterministicSearchClient: DeterministicSearchClient;
  readonly #channels: ReadonlyMap<string, NotificationChannel>;
  readonly #inspect: typeof inspectRetailerStatic;
  readonly #validate: typeof validateRetailerAdapter;
  readonly #log: (event: Record<string, unknown>) => void;
  readonly #now: () => Date;
  #fastTimer?: ReturnType<typeof setTimeout>;
  #slowTimer?: ReturnType<typeof setTimeout>;
  #searchTimer?: ReturnType<typeof setTimeout>;
  #fastRun?: Promise<FastMonitorSummary>;
  #slowRun?: Promise<SlowMonitorSummary>;
  #searchRun?: Promise<SearchMonitorSummary>;
  #controller?: AbortController;

  constructor(dependencies: MonitorDependencies) {
    this.#databaseFactory = dependencies.databaseFactory;
    if (!dependencies.registry && !dependencies.registryFactory) {
      throw new Error("InventoryMonitor requires a registry or registry factory.");
    }
    this.#registryFactory = dependencies.registryFactory ?? (() => dependencies.registry!);
    this.#config = dependencies.config;
    this.#searchClient = dependencies.searchClient;
    this.#deterministicSearchClient = dependencies.deterministicSearchClient;
    this.#channels = dependencies.notificationChannels ?? new Map();
    this.#inspect = dependencies.inspect ?? inspectRetailerStatic;
    this.#validate = dependencies.validate ?? validateRetailerAdapter;
    this.#log = dependencies.log ?? (() => undefined);
    this.#now = dependencies.now ?? (() => new Date());
  }

  start(): void {
    if (
      this.#controller ||
      (!this.#config.monitoring.enabled && !this.#config.searchMonitoring.enabled)
    ) return;
    this.#controller = new AbortController();
    if (this.#config.monitoring.enabled) {
      this.scheduleFast(this.#config.monitoring.fastIntervalSeconds * 1_000);
      this.scheduleSlow(this.#config.monitoring.slowIntervalHours * 60 * 60_000);
    }
    if (this.#config.searchMonitoring.enabled) this.scheduleSearch(60_000);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#fastTimer) clearTimeout(this.#fastTimer);
    if (this.#slowTimer) clearTimeout(this.#slowTimer);
    if (this.#searchTimer) clearTimeout(this.#searchTimer);
    this.#fastTimer = undefined;
    this.#slowTimer = undefined;
    this.#searchTimer = undefined;
    await Promise.allSettled([this.#fastRun, this.#slowRun, this.#searchRun].filter(Boolean));
  }

  status(): {
    enabled: boolean;
    running: { fast: boolean; slow: boolean; search: boolean };
    intervals: { fastSeconds: number; slowHours: number };
  } {
    return {
      enabled: this.#config.monitoring.enabled || this.#config.searchMonitoring.enabled,
      running: {
        fast: Boolean(this.#fastRun),
        slow: Boolean(this.#slowRun),
        search: Boolean(this.#searchRun),
      },
      intervals: {
        fastSeconds: this.#config.monitoring.fastIntervalSeconds,
        slowHours: this.#config.monitoring.slowIntervalHours,
      },
    };
  }

  runFast(
    options: {
      signal?: AbortSignal;
      deliverNotifications?: boolean;
      watchIds?: string[];
    } = {},
  ): Promise<FastMonitorSummary> {
    if (this.#fastRun) return this.#fastRun;
    const signal = this.combineWithLifecycleSignal(options.signal);
    this.#fastRun = this.executeFast(
      signal,
      options.deliverNotifications !== false,
      options.watchIds,
    ).finally(() => {
      this.#fastRun = undefined;
    });
    return this.#fastRun;
  }

  runSlow(
    options: { signal?: AbortSignal; watchIds?: string[]; dryRun?: boolean } = {},
  ): Promise<SlowMonitorSummary> {
    if (this.#slowRun) return this.#slowRun;
    const signal = this.combineWithLifecycleSignal(options.signal);
    this.#slowRun = (options.dryRun
      ? this.previewSlow(signal, options.watchIds)
      : this.executeSlow(signal, options.watchIds)).finally(() => {
      this.#slowRun = undefined;
    });
    return this.#slowRun;
  }

  runSearch(
    options: {
      signal?: AbortSignal;
      watchIds?: string[];
      dryRun?: boolean;
      deliverNotifications?: boolean;
      dueOnly?: boolean;
    } = {},
  ): Promise<SearchMonitorSummary> {
    if (this.#searchRun) return this.#searchRun;
    const signal = this.combineWithLifecycleSignal(options.signal);
    this.#searchRun = this.executeSearch({ ...options, signal }).finally(() => {
      this.#searchRun = undefined;
    });
    return this.#searchRun;
  }

  private combineWithLifecycleSignal(signal?: AbortSignal): AbortSignal | undefined {
    const lifecycleSignal = this.#controller?.signal;
    if (!signal) return lifecycleSignal;
    if (!lifecycleSignal) return signal;
    return AbortSignal.any([signal, lifecycleSignal]);
  }

  private scheduleFast(delayMs: number): void {
    if (!this.#controller) return;
    const jitterMs = Math.floor(Math.random() * this.#config.monitoring.jitterSeconds * 1_000);
    this.#fastTimer = setTimeout(() => {
      const signal = this.#controller?.signal;
      if (!signal || signal.aborted) return;
      void this.runFast({ signal })
        .catch((error) => this.#log({ event: "inventory_fast_loop_failed", error: safeError(error) }))
        .finally(() => this.scheduleFast(this.#config.monitoring.fastIntervalSeconds * 1_000));
    }, delayMs + jitterMs);
    this.#fastTimer.unref?.();
  }

  private scheduleSlow(delayMs: number): void {
    if (!this.#controller) return;
    const jitterMs = Math.floor(Math.random() * this.#config.monitoring.jitterSeconds * 1_000);
    this.#slowTimer = setTimeout(() => {
      const signal = this.#controller?.signal;
      if (!signal || signal.aborted) return;
      void this.runSlow({ signal })
        .catch((error) => this.#log({ event: "inventory_slow_loop_failed", error: safeError(error) }))
        .finally(() => this.scheduleSlow(this.#config.monitoring.slowIntervalHours * 60 * 60_000));
    }, delayMs + jitterMs);
    this.#slowTimer.unref?.();
  }

  private scheduleSearch(delayMs: number): void {
    if (!this.#controller) return;
    this.#searchTimer = setTimeout(() => {
      const signal = this.#controller?.signal;
      if (!signal || signal.aborted) return;
      void this.runSearch({ signal, dueOnly: true })
        .catch((error) => this.#log({ event: "inventory_search_loop_failed", error: safeError(error) }))
        .finally(() => this.scheduleSearch(60_000));
    }, delayMs);
    this.#searchTimer.unref?.();
  }

  private async executeSearch(options: {
    signal?: AbortSignal;
    watchIds?: string[];
    dryRun?: boolean;
    deliverNotifications?: boolean;
    dueOnly?: boolean;
  }): Promise<SearchMonitorSummary> {
    options.signal?.throwIfAborted();
    const database = this.#databaseFactory();
    const startedAt = this.#now().toISOString();
    const runId = options.dryRun ? undefined : database.startMonitorRun("search", startedAt);
    const summary: SearchMonitorSummary = {
      watchesConsidered: 0,
      watchesRun: 0,
      failures: 0,
      newResults: 0,
      notificationsRecommended: 0,
      results: [],
      delivery: { claimed: 0, sent: 0, failed: 0, terminal: 0 },
      ...(options.dryRun ? { dryRun: true as const } : {}),
    };
    try {

      const selectedIds = options.watchIds ? new Set(options.watchIds) : undefined;
      const nowMs = this.#now().getTime();
      const watches = database.listSearchWatches().filter((watch) =>
        watch.enabled &&
        (!selectedIds || selectedIds.has(watch.id)) &&
        (!options.dueOnly || !watch.nextCheckAt || Date.parse(watch.nextCheckAt) <= nowMs),
      );
      summary.watchesConsidered = database.listSearchWatches().filter(({ enabled }) => enabled).length;
      const discord = this.#config.notifications.discord;
      const notification = discord?.enabled && options.deliverNotifications !== false
        ? {
            channel: "discord",
            target: discord.target,
            accountId: discord.accountId,
            threadId: discord.threadId,
          }
        : undefined;
      const service = new SearchWatchService(database, this.#deterministicSearchClient, this.#now);
      for (const watch of watches) {
        try {
          const result = await service.run(watch.id, {
            signal: options.signal,
            dryRun: options.dryRun,
            notification,
          });
          summary.watchesRun += 1;
          summary.newResults += result.newResults.length;
          summary.notificationsRecommended += result.notificationsRecommended;
          summary.results.push(result);
        } catch (error) {
          options.signal?.throwIfAborted();
          summary.failures += 1;
          this.#log({ event: "inventory_search_watch_failed", watch_id: watch.id, error: safeError(error) });
        }
      }
      if (!options.dryRun && options.deliverNotifications !== false) {
        summary.delivery = await new NotificationDispatcher(
          database,
          this.#channels,
          {
            maxAttempts: this.#config.notifications.maxAttempts,
            batchSize: this.#config.notifications.batchSize,
            baseRetryMs: this.#config.notifications.baseRetrySeconds * 1_000,
          },
          this.#now,
        ).dispatch({ signal: options.signal });
      }
      if (runId !== undefined) {
        database.completeMonitorRun(runId, { completedAt: this.#now().toISOString(), summary });
      }
      return summary;
    } catch (error) {
      if (runId !== undefined) {
        database.completeMonitorRun(runId, {
          completedAt: this.#now().toISOString(),
          error: safeError(error),
        });
      }
      throw error;
    } finally {
      database.close();
    }
  }

  private async executeFast(
    signal: AbortSignal | undefined,
    deliverNotifications: boolean,
    watchIds?: string[],
  ): Promise<FastMonitorSummary> {
    signal?.throwIfAborted();
    const database = this.#databaseFactory();
    const startedAt = this.#now().toISOString();
    const runId = database.startMonitorRun("fast", startedAt);
    try {
      signal?.throwIfAborted();
      const selectedWatchIds = watchIds ? new Set(watchIds) : undefined;
      const watches = database.listWatches().filter(({ id, enabled }) =>
        enabled && (!selectedWatchIds || selectedWatchIds.has(id)),
      );
      let checkedTargets = 0;
      let watchFailures = 0;
      let notificationsRecommended = 0;
      const discord = this.#config.notifications.discord;
      const notification = discord?.enabled && deliverNotifications
        ? {
            channel: "discord",
            target: discord.target,
            accountId: discord.accountId,
            threadId: discord.threadId,
          }
        : undefined;
      const domainLimiter = new DomainConcurrencyLimiter(
        this.#config.monitoring.perDomainConcurrency,
      );
      const service = new WatchService(
        database,
        this.#registryFactory(database),
        (record: WatchLogRecord) => this.#log({ event: "inventory_check", ...record }),
        this.#now,
        (domain, operation) => domainLimiter.run(domain, operation),
      );
      await mapConcurrent(watches, this.#config.monitoring.maxConcurrency, async (watch) => {
        try {
          signal?.throwIfAborted();
          const result = await service.run(watch.id, {
            timeoutMs: this.#config.monitoring.timeoutMs,
            notifyWhenUnavailable: this.#config.monitoring.notifyWhenUnavailable,
            signal,
            notification,
          });
          checkedTargets += result.summary.checked;
          notificationsRecommended += result.summary.notificationsRecommended;
        } catch (error) {
          signal?.throwIfAborted();
          watchFailures += 1;
          this.#log({ event: "inventory_watch_failed", watch_id: watch.id, error: safeError(error) });
        }
      });
      signal?.throwIfAborted();
      const delivery = deliverNotifications
        ? await new NotificationDispatcher(
            database,
            this.#channels,
            {
              maxAttempts: this.#config.notifications.maxAttempts,
              batchSize: this.#config.notifications.batchSize,
              baseRetryMs: this.#config.notifications.baseRetrySeconds * 1_000,
            },
            this.#now,
          ).dispatch({ signal })
        : { claimed: 0, sent: 0, failed: 0, terminal: 0 };
      const summary = {
        watches: watches.length,
        checkedTargets,
        watchFailures,
        notificationsRecommended,
        delivery,
      };
      database.completeMonitorRun(runId, { completedAt: this.#now().toISOString(), summary });
      return summary;
    } catch (error) {
      database.completeMonitorRun(runId, {
        completedAt: this.#now().toISOString(),
        error: safeError(error),
      });
      throw error;
    } finally {
      database.close();
    }
  }

  private async previewSlow(
    signal?: AbortSignal,
    watchIds?: string[],
  ): Promise<SlowMonitorSummary> {
    signal?.throwIfAborted();
    const database = this.#databaseFactory();
    try {
      const selectedWatchIds = watchIds ? new Set(watchIds) : undefined;
      const watches = database.listWatches().filter(({ id, enabled }) =>
        enabled && (!selectedWatchIds || selectedWatchIds.has(id)),
      );
      const staleBefore = this.#now().getTime() -
        this.#config.monitoring.rediscoveryAfterHours * 60 * 60_000;
      let inspectableTargets = 0;
      for (const watch of watches) {
        for (const target of watch.retailers.filter(({ enabled }) => enabled)) {
          const statuses = database.recentStatuses(
            target.id,
            this.#config.monitoring.inspectAfterUnknownCount,
          );
          if (
            statuses.length >= this.#config.monitoring.inspectAfterUnknownCount &&
            statuses.every((status) => status === "unknown" || status === "error")
          ) {
            inspectableTargets += 1;
          }
        }
      }
      return {
        watchesConsidered: watches.length,
        discoveries: 0,
        candidatesFound: 0,
        targetsInspected: 0,
        adapterCandidatesGenerated: 0,
        adapterCandidatesValidated: 0,
        failures: 0,
        dryRun: true,
        preview: {
          staleWatches: watches.filter(({ lastDiscoveryAt }) =>
            (lastDiscoveryAt ? Date.parse(lastDiscoveryAt) : 0) <= staleBefore,
          ).length,
          inspectableTargets,
        },
      };
    } finally {
      database.close();
    }
  }

  private async executeSlow(
    signal?: AbortSignal,
    watchIds?: string[],
  ): Promise<SlowMonitorSummary> {
    signal?.throwIfAborted();
    const database = this.#databaseFactory();
    const runId = database.startMonitorRun("slow", this.#now().toISOString());
    const summary: SlowMonitorSummary = {
      watchesConsidered: 0,
      discoveries: 0,
      candidatesFound: 0,
      targetsInspected: 0,
      adapterCandidatesGenerated: 0,
      adapterCandidatesValidated: 0,
      failures: 0,
    };
    try {
      const now = this.#now();
      const registry = this.#registryFactory(database);
      const staleBefore = now.getTime() - this.#config.monitoring.rediscoveryAfterHours * 60 * 60_000;
      const selectedWatchIds = watchIds ? new Set(watchIds) : undefined;
      const watches = database.listWatches().filter(({ id, enabled }) =>
        enabled && (!selectedWatchIds || selectedWatchIds.has(id)),
      );
      summary.watchesConsidered = watches.length;

      for (const watch of watches) {
        signal?.throwIfAborted();
        const lastDiscovery = watch.lastDiscoveryAt ? Date.parse(watch.lastDiscoveryAt) : 0;
        if (this.#searchClient && lastDiscovery <= staleBefore) {
          try {
            const result = await discoverRetailers(watch.product, this.#searchClient, { signal });
            signal?.throwIfAborted();
            database.saveRetailerCandidates(watch.productId, result.candidates, now.toISOString());
            if (result.candidates.length > 0 || result.errors.length === 0) {
              database.markWatchDiscovered(watch.id, now.toISOString());
              summary.discoveries += 1;
            } else {
              summary.failures += 1;
              this.#log({
                event: "inventory_discovery_incomplete",
                watch_id: watch.id,
                error_count: result.errors.length,
              });
            }
            summary.candidatesFound += result.candidates.length;
          } catch (error) {
            signal?.throwIfAborted();
            summary.failures += 1;
            this.#log({ event: "inventory_discovery_failed", watch_id: watch.id, error: safeError(error) });
          }
        }

        for (const target of watch.retailers.filter(({ enabled }) => enabled)) {
          const statuses = database.recentStatuses(
            target.id,
            this.#config.monitoring.inspectAfterUnknownCount,
          );
          if (
            statuses.length < this.#config.monitoring.inspectAfterUnknownCount ||
            statuses.some((status) => status !== "unknown" && status !== "error")
          ) continue;
          try {
            signal?.throwIfAborted();
            const inspection = await this.#inspect(target.url, {
              expectedProduct: watch.product,
              timeoutMs: this.#config.monitoring.timeoutMs,
              signal,
            });
            signal?.throwIfAborted();
            database.recordSlowInspection(watch.id, target.id, inspection);
            summary.targetsInspected += 1;
            const candidate = await this.generateAndValidateCandidate(
              database,
              watch.product,
              target.domain,
              inspection,
              registry,
              signal,
            );
            if (candidate.generated) summary.adapterCandidatesGenerated += 1;
            if (candidate.validated) summary.adapterCandidatesValidated += 1;
          } catch (error) {
            signal?.throwIfAborted();
            summary.failures += 1;
            this.#log({
              event: "inventory_inspection_failed",
              watch_id: watch.id,
              target_id: target.id,
              error: safeError(error),
            });
          }
        }
      }
      database.completeMonitorRun(runId, { completedAt: this.#now().toISOString(), summary });
      return summary;
    } catch (error) {
      database.completeMonitorRun(runId, {
        completedAt: this.#now().toISOString(),
        summary,
        error: safeError(error),
      });
      throw error;
    } finally {
      database.close();
    }
  }

  private async generateAndValidateCandidate(
    database: InventoryDatabase,
    expectedProduct: Parameters<typeof matchProductIdentity>[0],
    domain: string,
    inspection: RetailerInspection,
    registry: AdapterRegistry,
    signal?: AbortSignal,
  ): Promise<{ generated: boolean; validated: boolean }> {
    if (!inspection.sanitizedFixture || inspection.inventory.method !== "json_ld") {
      return { generated: false, validated: false };
    }
    const match = inspection.product
      ? matchProductIdentity(expectedProduct, inspection.product)
      : { confidence: 0 };
    const generated = generateRetailerAdapter(domain, [{
      url: inspection.finalUrl,
      status: inspection.inventory.status,
      confidence: inspection.inventory.confidence,
      method: inspection.inventory.method,
      productMatchConfidence: match.confidence,
      evidenceSummary: inspection.inventory.evidence.summary,
    }], {
      generationReason: registry.get(inspection.finalUrl) ? "repair" : "unsupported_retailer",
      now: this.#now,
    });
    if (!generated.generated) return { generated: false, validated: false };
    signal?.throwIfAborted();
    database.saveAdapterCandidate(generated.candidate);
    const report = await this.#validate(generated.candidate, {
      fixture: {
        url: inspection.finalUrl,
        html: inspection.sanitizedFixture.html,
        expectedProduct,
        expectedStatus: inspection.inventory.status,
      },
      live: {
        url: inspection.finalUrl,
        expectedProduct,
        observedStatus: inspection.inventory.status,
        observationConfidence: inspection.inventory.confidence,
        timeoutMs: this.#config.monitoring.timeoutMs,
        signal,
      },
    });
    signal?.throwIfAborted();
    database.saveValidation(generated.candidate, report);
    return { generated: true, validated: report.valid };
  }
}
