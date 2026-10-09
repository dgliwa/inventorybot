import { discoverRetailers } from "../discovery/discover.js";
import { matchProductIdentity } from "../domain/product.js";
import { generateRetailerAdapter } from "../generation/generate-adapter.js";
import { validateRetailerAdapter } from "../generation/validate-adapter.js";
import { inspectRetailerStatic } from "../inspection/static.js";
import { NotificationDispatcher } from "../notifications/dispatcher.js";
import { SearchWatchService } from "../search-watches/service.js";
import { WatchService } from "../watches/service.js";
import { DomainConcurrencyLimiter } from "./concurrency.js";
function safeError(error) {
    return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s]+/g, (value) => {
        try {
            const url = new URL(value);
            url.search = "";
            url.hash = "";
            return url.toString();
        }
        catch {
            return "[redacted-url]";
        }
    });
}
async function mapConcurrent(values, concurrency, worker) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (next < values.length) {
            const index = next++;
            await worker(values[index]);
        }
    }));
}
export class InventoryMonitor {
    #databaseFactory;
    #registryFactory;
    #config;
    #searchClient;
    #deterministicSearchClient;
    #channels;
    #inspect;
    #validate;
    #log;
    #now;
    #fastTimer;
    #slowTimer;
    #searchTimer;
    #fastRun;
    #slowRun;
    #searchRun;
    #controller;
    constructor(dependencies) {
        this.#databaseFactory = dependencies.databaseFactory;
        if (!dependencies.registry && !dependencies.registryFactory) {
            throw new Error("InventoryMonitor requires a registry or registry factory.");
        }
        this.#registryFactory = dependencies.registryFactory ?? (() => dependencies.registry);
        this.#config = dependencies.config;
        this.#searchClient = dependencies.searchClient;
        this.#deterministicSearchClient = dependencies.deterministicSearchClient;
        this.#channels = dependencies.notificationChannels ?? new Map();
        this.#inspect = dependencies.inspect ?? inspectRetailerStatic;
        this.#validate = dependencies.validate ?? validateRetailerAdapter;
        this.#log = dependencies.log ?? (() => undefined);
        this.#now = dependencies.now ?? (() => new Date());
    }
    start() {
        if (this.#controller ||
            (!this.#config.monitoring.enabled && !this.#config.searchMonitoring.enabled))
            return;
        this.#controller = new AbortController();
        if (this.#config.monitoring.enabled) {
            this.scheduleFast(this.#config.monitoring.fastIntervalSeconds * 1_000);
            this.scheduleSlow(this.#config.monitoring.slowIntervalHours * 60 * 60_000);
        }
        if (this.#config.searchMonitoring.enabled)
            this.scheduleSearch(60_000);
    }
    async stop() {
        this.#controller?.abort();
        this.#controller = undefined;
        if (this.#fastTimer)
            clearTimeout(this.#fastTimer);
        if (this.#slowTimer)
            clearTimeout(this.#slowTimer);
        if (this.#searchTimer)
            clearTimeout(this.#searchTimer);
        this.#fastTimer = undefined;
        this.#slowTimer = undefined;
        this.#searchTimer = undefined;
        await Promise.allSettled([this.#fastRun, this.#slowRun, this.#searchRun].filter(Boolean));
    }
    status() {
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
    runFast(options = {}) {
        if (this.#fastRun)
            return this.#fastRun;
        const signal = this.combineWithLifecycleSignal(options.signal);
        this.#fastRun = this.executeFast(signal, options.deliverNotifications !== false, options.watchIds).finally(() => {
            this.#fastRun = undefined;
        });
        return this.#fastRun;
    }
    runSlow(options = {}) {
        if (this.#slowRun)
            return this.#slowRun;
        const signal = this.combineWithLifecycleSignal(options.signal);
        this.#slowRun = (options.dryRun
            ? this.previewSlow(signal, options.watchIds)
            : this.executeSlow(signal, options.watchIds)).finally(() => {
            this.#slowRun = undefined;
        });
        return this.#slowRun;
    }
    runSearch(options = {}) {
        if (this.#searchRun)
            return this.#searchRun;
        const signal = this.combineWithLifecycleSignal(options.signal);
        this.#searchRun = this.executeSearch({ ...options, signal }).finally(() => {
            this.#searchRun = undefined;
        });
        return this.#searchRun;
    }
    combineWithLifecycleSignal(signal) {
        const lifecycleSignal = this.#controller?.signal;
        if (!signal)
            return lifecycleSignal;
        if (!lifecycleSignal)
            return signal;
        return AbortSignal.any([signal, lifecycleSignal]);
    }
    scheduleFast(delayMs) {
        if (!this.#controller)
            return;
        const jitterMs = Math.floor(Math.random() * this.#config.monitoring.jitterSeconds * 1_000);
        this.#fastTimer = setTimeout(() => {
            const signal = this.#controller?.signal;
            if (!signal || signal.aborted)
                return;
            void this.runFast({ signal })
                .catch((error) => this.#log({ event: "inventory_fast_loop_failed", error: safeError(error) }))
                .finally(() => this.scheduleFast(this.#config.monitoring.fastIntervalSeconds * 1_000));
        }, delayMs + jitterMs);
        this.#fastTimer.unref?.();
    }
    scheduleSlow(delayMs) {
        if (!this.#controller)
            return;
        const jitterMs = Math.floor(Math.random() * this.#config.monitoring.jitterSeconds * 1_000);
        this.#slowTimer = setTimeout(() => {
            const signal = this.#controller?.signal;
            if (!signal || signal.aborted)
                return;
            void this.runSlow({ signal })
                .catch((error) => this.#log({ event: "inventory_slow_loop_failed", error: safeError(error) }))
                .finally(() => this.scheduleSlow(this.#config.monitoring.slowIntervalHours * 60 * 60_000));
        }, delayMs + jitterMs);
        this.#slowTimer.unref?.();
    }
    scheduleSearch(delayMs) {
        if (!this.#controller)
            return;
        this.#searchTimer = setTimeout(() => {
            const signal = this.#controller?.signal;
            if (!signal || signal.aborted)
                return;
            void this.runSearch({ signal, dueOnly: true })
                .catch((error) => this.#log({ event: "inventory_search_loop_failed", error: safeError(error) }))
                .finally(() => this.scheduleSearch(60_000));
        }, delayMs);
        this.#searchTimer.unref?.();
    }
    async executeSearch(options) {
        options.signal?.throwIfAborted();
        const database = this.#databaseFactory();
        const startedAt = this.#now().toISOString();
        const runId = options.dryRun ? undefined : database.startMonitorRun("search", startedAt);
        const summary = {
            watchesConsidered: 0,
            watchesRun: 0,
            failures: 0,
            newResults: 0,
            notificationsRecommended: 0,
            results: [],
            delivery: { claimed: 0, sent: 0, failed: 0, terminal: 0 },
            ...(options.dryRun ? { dryRun: true } : {}),
        };
        try {
            const selectedIds = options.watchIds ? new Set(options.watchIds) : undefined;
            const nowMs = this.#now().getTime();
            const watches = database.listSearchWatches().filter((watch) => watch.enabled &&
                (!selectedIds || selectedIds.has(watch.id)) &&
                (!options.dueOnly || !watch.nextCheckAt || Date.parse(watch.nextCheckAt) <= nowMs));
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
                }
                catch (error) {
                    options.signal?.throwIfAborted();
                    summary.failures += 1;
                    this.#log({ event: "inventory_search_watch_failed", watch_id: watch.id, error: safeError(error) });
                }
            }
            if (!options.dryRun && options.deliverNotifications !== false) {
                summary.delivery = await new NotificationDispatcher(database, this.#channels, {
                    maxAttempts: this.#config.notifications.maxAttempts,
                    batchSize: this.#config.notifications.batchSize,
                    baseRetryMs: this.#config.notifications.baseRetrySeconds * 1_000,
                }, this.#now).dispatch({ signal: options.signal });
            }
            if (runId !== undefined) {
                database.completeMonitorRun(runId, { completedAt: this.#now().toISOString(), summary });
            }
            return summary;
        }
        catch (error) {
            if (runId !== undefined) {
                database.completeMonitorRun(runId, {
                    completedAt: this.#now().toISOString(),
                    error: safeError(error),
                });
            }
            throw error;
        }
        finally {
            database.close();
        }
    }
    async executeFast(signal, deliverNotifications, watchIds) {
        signal?.throwIfAborted();
        const database = this.#databaseFactory();
        const startedAt = this.#now().toISOString();
        const runId = database.startMonitorRun("fast", startedAt);
        try {
            signal?.throwIfAborted();
            const selectedWatchIds = watchIds ? new Set(watchIds) : undefined;
            const watches = database.listWatches().filter(({ id, enabled }) => enabled && (!selectedWatchIds || selectedWatchIds.has(id)));
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
            const domainLimiter = new DomainConcurrencyLimiter(this.#config.monitoring.perDomainConcurrency);
            const service = new WatchService(database, this.#registryFactory(database), (record) => this.#log({ event: "inventory_check", ...record }), this.#now, (domain, operation) => domainLimiter.run(domain, operation));
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
                }
                catch (error) {
                    signal?.throwIfAborted();
                    watchFailures += 1;
                    this.#log({ event: "inventory_watch_failed", watch_id: watch.id, error: safeError(error) });
                }
            });
            signal?.throwIfAborted();
            const delivery = deliverNotifications
                ? await new NotificationDispatcher(database, this.#channels, {
                    maxAttempts: this.#config.notifications.maxAttempts,
                    batchSize: this.#config.notifications.batchSize,
                    baseRetryMs: this.#config.notifications.baseRetrySeconds * 1_000,
                }, this.#now).dispatch({ signal })
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
        }
        catch (error) {
            database.completeMonitorRun(runId, {
                completedAt: this.#now().toISOString(),
                error: safeError(error),
            });
            throw error;
        }
        finally {
            database.close();
        }
    }
    async previewSlow(signal, watchIds) {
        signal?.throwIfAborted();
        const database = this.#databaseFactory();
        try {
            const selectedWatchIds = watchIds ? new Set(watchIds) : undefined;
            const watches = database.listWatches().filter(({ id, enabled }) => enabled && (!selectedWatchIds || selectedWatchIds.has(id)));
            const staleBefore = this.#now().getTime() -
                this.#config.monitoring.rediscoveryAfterHours * 60 * 60_000;
            let inspectableTargets = 0;
            for (const watch of watches) {
                for (const target of watch.retailers.filter(({ enabled }) => enabled)) {
                    const statuses = database.recentStatuses(target.id, this.#config.monitoring.inspectAfterUnknownCount);
                    if (statuses.length >= this.#config.monitoring.inspectAfterUnknownCount &&
                        statuses.every((status) => status === "unknown" || status === "error")) {
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
                    staleWatches: watches.filter(({ lastDiscoveryAt }) => (lastDiscoveryAt ? Date.parse(lastDiscoveryAt) : 0) <= staleBefore).length,
                    inspectableTargets,
                },
            };
        }
        finally {
            database.close();
        }
    }
    async executeSlow(signal, watchIds) {
        signal?.throwIfAborted();
        const database = this.#databaseFactory();
        const runId = database.startMonitorRun("slow", this.#now().toISOString());
        const summary = {
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
            const watches = database.listWatches().filter(({ id, enabled }) => enabled && (!selectedWatchIds || selectedWatchIds.has(id)));
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
                        }
                        else {
                            summary.failures += 1;
                            this.#log({
                                event: "inventory_discovery_incomplete",
                                watch_id: watch.id,
                                error_count: result.errors.length,
                            });
                        }
                        summary.candidatesFound += result.candidates.length;
                    }
                    catch (error) {
                        signal?.throwIfAborted();
                        summary.failures += 1;
                        this.#log({ event: "inventory_discovery_failed", watch_id: watch.id, error: safeError(error) });
                    }
                }
                for (const target of watch.retailers.filter(({ enabled }) => enabled)) {
                    const statuses = database.recentStatuses(target.id, this.#config.monitoring.inspectAfterUnknownCount);
                    if (statuses.length < this.#config.monitoring.inspectAfterUnknownCount ||
                        statuses.some((status) => status !== "unknown" && status !== "error"))
                        continue;
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
                        const candidate = await this.generateAndValidateCandidate(database, watch.product, target.domain, inspection, registry, signal);
                        if (candidate.generated)
                            summary.adapterCandidatesGenerated += 1;
                        if (candidate.validated)
                            summary.adapterCandidatesValidated += 1;
                    }
                    catch (error) {
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
        }
        catch (error) {
            database.completeMonitorRun(runId, {
                completedAt: this.#now().toISOString(),
                summary,
                error: safeError(error),
            });
            throw error;
        }
        finally {
            database.close();
        }
    }
    async generateAndValidateCandidate(database, expectedProduct, domain, inspection, registry, signal) {
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
        if (!generated.generated)
            return { generated: false, validated: false };
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
