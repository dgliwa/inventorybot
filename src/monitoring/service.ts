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

export type SlowMonitorSummary = {
  watchesConsidered: number;
  discoveries: number;
  candidatesFound: number;
  targetsInspected: number;
  adapterCandidatesGenerated: number;
  adapterCandidatesValidated: number;
  failures: number;
};

type MonitorDependencies = {
  databaseFactory: () => InventoryDatabase;
  registry?: AdapterRegistry;
  registryFactory?: (database: InventoryDatabase) => AdapterRegistry;
  config: InventoryBotConfig;
  searchClient?: RetailerSearchClient;
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
  readonly #channels: ReadonlyMap<string, NotificationChannel>;
  readonly #inspect: typeof inspectRetailerStatic;
  readonly #validate: typeof validateRetailerAdapter;
  readonly #log: (event: Record<string, unknown>) => void;
  readonly #now: () => Date;
  #fastTimer?: ReturnType<typeof setTimeout>;
  #slowTimer?: ReturnType<typeof setTimeout>;
  #fastRun?: Promise<FastMonitorSummary>;
  #slowRun?: Promise<SlowMonitorSummary>;
  #controller?: AbortController;

  constructor(dependencies: MonitorDependencies) {
    this.#databaseFactory = dependencies.databaseFactory;
    if (!dependencies.registry && !dependencies.registryFactory) {
      throw new Error("InventoryMonitor requires a registry or registry factory.");
    }
    this.#registryFactory = dependencies.registryFactory ?? (() => dependencies.registry!);
    this.#config = dependencies.config;
    this.#searchClient = dependencies.searchClient;
    this.#channels = dependencies.notificationChannels ?? new Map();
    this.#inspect = dependencies.inspect ?? inspectRetailerStatic;
    this.#validate = dependencies.validate ?? validateRetailerAdapter;
    this.#log = dependencies.log ?? (() => undefined);
    this.#now = dependencies.now ?? (() => new Date());
  }

  start(): void {
    if (this.#controller || !this.#config.monitoring.enabled) return;
    this.#controller = new AbortController();
    this.scheduleFast(this.#config.monitoring.fastIntervalSeconds * 1_000);
    this.scheduleSlow(this.#config.monitoring.slowIntervalHours * 60 * 60_000);
  }

  async stop(): Promise<void> {
    this.#controller?.abort();
    this.#controller = undefined;
    if (this.#fastTimer) clearTimeout(this.#fastTimer);
    if (this.#slowTimer) clearTimeout(this.#slowTimer);
    this.#fastTimer = undefined;
    this.#slowTimer = undefined;
    await Promise.allSettled([this.#fastRun, this.#slowRun].filter(Boolean));
  }

  status(): {
    enabled: boolean;
    running: { fast: boolean; slow: boolean };
    intervals: { fastSeconds: number; slowHours: number };
  } {
    return {
      enabled: this.#config.monitoring.enabled,
      running: { fast: Boolean(this.#fastRun), slow: Boolean(this.#slowRun) },
      intervals: {
        fastSeconds: this.#config.monitoring.fastIntervalSeconds,
        slowHours: this.#config.monitoring.slowIntervalHours,
      },
    };
  }

  runFast(options: { signal?: AbortSignal } = {}): Promise<FastMonitorSummary> {
    if (this.#fastRun) return this.#fastRun;
    const signal = this.combineWithLifecycleSignal(options.signal);
    this.#fastRun = this.executeFast(signal).finally(() => {
      this.#fastRun = undefined;
    });
    return this.#fastRun;
  }

  runSlow(options: { signal?: AbortSignal } = {}): Promise<SlowMonitorSummary> {
    if (this.#slowRun) return this.#slowRun;
    const signal = this.combineWithLifecycleSignal(options.signal);
    this.#slowRun = this.executeSlow(signal).finally(() => {
      this.#slowRun = undefined;
    });
    return this.#slowRun;
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

  private async executeFast(signal?: AbortSignal): Promise<FastMonitorSummary> {
    signal?.throwIfAborted();
    const database = this.#databaseFactory();
    const startedAt = this.#now().toISOString();
    const runId = database.startMonitorRun("fast", startedAt);
    try {
      signal?.throwIfAborted();
      const watches = database.listWatches().filter(({ enabled }) => enabled);
      let checkedTargets = 0;
      let watchFailures = 0;
      let notificationsRecommended = 0;
      const discord = this.#config.notifications.discord;
      const notification = discord?.enabled
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
      const delivery = await new NotificationDispatcher(
        database,
        this.#channels,
        {
          maxAttempts: this.#config.notifications.maxAttempts,
          batchSize: this.#config.notifications.batchSize,
          baseRetryMs: this.#config.notifications.baseRetrySeconds * 1_000,
        },
        this.#now,
      ).dispatch({ signal });
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

  private async executeSlow(signal?: AbortSignal): Promise<SlowMonitorSummary> {
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
      const watches = database.listWatches().filter(({ enabled }) => enabled);
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
