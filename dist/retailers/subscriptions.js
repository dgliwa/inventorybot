import { randomUUID } from "node:crypto";
import { normalizeDomain } from "../adapters/url.js";
function normalizeStores(stores) {
    const unique = new Map();
    for (const [index, store] of stores.entries()) {
        const storeId = store.storeId.trim();
        const name = store.name.trim();
        if (!storeId || !name)
            throw new Error("Retailer stores require a store ID and name.");
        unique.set(storeId, {
            storeId,
            name,
            ...(store.address?.trim() ? { address: store.address.trim() } : {}),
            primary: store.primary === true || (index === 0 && !stores.some(({ primary }) => primary)),
        });
    }
    const normalized = [...unique.values()];
    if (normalized.filter(({ primary }) => primary).length > 1) {
        throw new Error("A retailer subscription may have only one primary store.");
    }
    return normalized;
}
export class RetailerSubscriptionService {
    database;
    now;
    constructor(database, now = () => new Date()) {
        this.database = database;
        this.now = now;
    }
    add(input) {
        const domain = normalizeDomain(input.domain.includes("://") ? input.domain : `https://${input.domain}`);
        const postalCode = input.postalCode.trim();
        if (!postalCode)
            throw new Error("A postal code is required for local inventory checks.");
        const stores = normalizeStores(input.stores ?? []);
        const timestamp = this.now().toISOString();
        return this.database.createRetailerSubscription({
            id: randomUUID(),
            domain,
            postalCode,
            radiusMiles: input.radiusMiles ?? 25,
            stores,
            enabled: input.enabled ?? true,
            createdAt: timestamp,
            updatedAt: timestamp,
        });
    }
    update(input) {
        return this.database.updateRetailerSubscription(input.subscriptionId, {
            ...(input.postalCode !== undefined ? { postalCode: input.postalCode.trim() } : {}),
            ...(input.radiusMiles !== undefined ? { radiusMiles: input.radiusMiles } : {}),
            ...(input.stores !== undefined ? { stores: normalizeStores(input.stores) } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            updatedAt: this.now().toISOString(),
        });
    }
    status(subscriptionId) {
        return subscriptionId
            ? this.database.getRetailerSubscription(subscriptionId)
            : this.database.listRetailerSubscriptions();
    }
    remove(subscriptionId) {
        return this.database.disableRetailerSubscription(subscriptionId, this.now().toISOString());
    }
}
