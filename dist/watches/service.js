import { randomUUID } from "node:crypto";
import { normalizeDomain } from "../adapters/url.js";
import { normalizeInventoryResult } from "../domain/inventory.js";
import { checkInventory } from "../tools/check-inventory.js";
import { detectInventoryTransition } from "./transitions.js";
function canonicalRetailerUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error("Retailer targets must be credential-free HTTP(S) URLs.");
    }
    url.hash = "";
    return { url: url.toString(), domain: normalizeDomain(url.toString()) };
}
function redactedLogUrl(value) {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
    }
    catch {
        return "invalid-url";
    }
}
export class WatchService {
    database;
    registry;
    log;
    now;
    checkGate;
    constructor(database, registry, log = () => undefined, now = () => new Date(), checkGate = (_domain, operation) => operation()) {
        this.database = database;
        this.registry = registry;
        this.log = log;
        this.now = now;
        this.checkGate = checkGate;
    }
    add(input, options = {}) {
        options.signal?.throwIfAborted();
        if (input.retailers.length === 0)
            throw new Error("At least one retailer target is required.");
        if (!Object.values(input.product).some((value) => typeof value === "string" && value.trim())) {
            throw new Error("At least one product identity field is required.");
        }
        const uniqueTargets = new Map();
        for (const retailer of input.retailers) {
            const normalized = canonicalRetailerUrl(retailer.url);
            uniqueTargets.set(normalized.url, { ...normalized, enabled: retailer.enabled ?? true });
        }
        const createdAt = this.now().toISOString();
        options.signal?.throwIfAborted();
        return this.database.createWatch({
            id: randomUUID(),
            productId: randomUUID(),
            product: input.product,
            targets: [...uniqueTargets.values()].map((target) => ({ id: randomUUID(), ...target })),
            enabled: input.enabled ?? true,
            createdAt,
        });
    }
    remove(watchId, options = {}) {
        options.signal?.throwIfAborted();
        return { watchId, removed: this.database.removeWatch(watchId) };
    }
    status(watchId) {
        return watchId ? this.database.getWatch(watchId) : this.database.listWatches();
    }
    async run(watchId, options = {}) {
        const watch = this.database.getWatch(watchId);
        if (!watch)
            throw new Error(`WATCH_NOT_FOUND: ${watchId}`);
        if (!watch.enabled)
            throw new Error(`WATCH_DISABLED: ${watchId}`);
        const startedAt = this.now().toISOString();
        const targets = [];
        for (const target of watch.retailers.filter(({ enabled }) => enabled)) {
            options.signal?.throwIfAborted();
            const before = performance.now();
            const adapter = this.registry.get(target.url);
            let result;
            try {
                result = await this.checkGate(target.domain, () => checkInventory({
                    url: target.url,
                    expectedProduct: watch.product,
                    timeoutMs: options.timeoutMs,
                    signal: options.signal,
                }, this.registry));
            }
            catch (error) {
                if (options.signal?.aborted)
                    throw error;
                result = normalizeInventoryResult({
                    status: "error",
                    confidence: 1,
                    domain: target.domain,
                    url: target.url,
                    method: "unknown",
                    evidence: { summary: "The retailer adapter threw an unexpected error." },
                    error: {
                        code: "ADAPTER_FAILED",
                        message: error instanceof Error ? error.message : String(error),
                    },
                });
            }
            options.signal?.throwIfAborted();
            const durationMs = Math.max(0, Math.round(performance.now() - before));
            const previousStatus = this.database.latestStatus(target.id);
            const transition = detectInventoryTransition(previousStatus, result.status, {
                notifyWhenUnavailable: options.notifyWhenUnavailable,
            });
            const adapterId = adapter?.id;
            const adapterVersion = adapter?.version;
            this.database.recordObservation({
                watchId: watch.id,
                productId: watch.productId,
                targetId: target.id,
                result,
                adapterId,
                adapterVersion,
                durationMs,
                previousStatus,
                transitionChanged: transition.changed,
                ...(transition.notifyRecommended && options.notification
                    ? {
                        notification: {
                            ...options.notification,
                            payload: {
                                kind: "inventory_transition",
                                watchId: watch.id,
                                targetId: target.id,
                                productName: watch.product.name ?? watch.product.sku ?? "Watched product",
                                ...(watch.product.sku ? { productSku: watch.product.sku } : {}),
                                retailerDomain: target.domain,
                                url: target.url,
                                ...(previousStatus ? { previousStatus } : {}),
                                currentStatus: result.status,
                                ...(result.price !== undefined ? { price: result.price } : {}),
                                ...(result.currency ? { currency: result.currency } : {}),
                                confidence: result.confidence,
                                checkedAt: result.checkedAt,
                            },
                        },
                    }
                    : {}),
            });
            const requiresInspection = result.status === "unknown" || result.status === "error";
            const targetRun = {
                targetId: target.id,
                domain: target.domain,
                url: target.url,
                adapterId,
                adapterVersion,
                result,
                transition,
                requiresInspection,
                durationMs,
            };
            targets.push(targetRun);
            this.log({
                watch_id: watch.id,
                product_id: watch.productId,
                domain: target.domain,
                url: redactedLogUrl(target.url),
                adapter_id: adapterId,
                adapter_version: adapterVersion,
                status: result.status,
                confidence: result.confidence,
                method: result.method,
                duration_ms: durationMs,
                checked_at: result.checkedAt,
            });
        }
        return {
            watchId,
            startedAt,
            completedAt: this.now().toISOString(),
            targets,
            summary: {
                checked: targets.length,
                available: targets.filter(({ result }) => result.status === "in_stock").length,
                requiresInspection: targets.filter(({ requiresInspection }) => requiresInspection).length,
                notificationsRecommended: targets.filter(({ transition }) => transition.notifyRecommended).length,
            },
        };
    }
}
