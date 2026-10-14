import { randomUUID } from "node:crypto";
import { WISHLIST_LINK_KINDS, WISHLIST_PRIORITIES, WISHLIST_STATUSES, } from "./types.js";
export class WishlistValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "WishlistValidationError";
    }
}
function nonBlank(value, field) {
    const normalized = value.trim();
    if (!normalized)
        throw new WishlistValidationError(`${field} must not be blank`);
    return normalized;
}
function optionalText(value, field) {
    if (value === undefined || value === null)
        return value;
    return nonBlank(value, field);
}
function normalizeTags(tags) {
    if (!tags)
        return [];
    return [...new Set(tags.map((tag) => nonBlank(tag, "tag").toLowerCase()))].sort();
}
function positiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new WishlistValidationError(`${field} must be a positive integer`);
    }
    return value;
}
function nonnegative(value, field) {
    if (value === undefined)
        return undefined;
    if (!Number.isFinite(value) || value < 0)
        throw new WishlistValidationError(`${field} must be zero or greater`);
    return value;
}
function dateOnly(value) {
    const candidate = value ?? new Date().toISOString().slice(0, 10);
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) ||
        Number.isNaN(parsed.valueOf()) ||
        parsed.toISOString().slice(0, 10) !== candidate) {
        throw new WishlistValidationError("purchasedAt must be a real date formatted as YYYY-MM-DD");
    }
    return candidate;
}
function absoluteHttpUrl(value) {
    try {
        const parsed = new URL(value);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
            throw new Error();
        parsed.hash = "";
        return parsed.toString();
    }
    catch {
        throw new WishlistValidationError("url must be an absolute HTTP(S) URL without embedded credentials");
    }
}
export class WishlistService {
    database;
    now;
    constructor(database, now = () => new Date()) {
        this.database = database;
        this.now = now;
    }
    add(input) {
        const now = this.now().toISOString();
        const item = {
            id: randomUUID(),
            name: nonBlank(input.name, "name"),
            ...(input.category ? { category: nonBlank(input.category, "category") } : {}),
            priority: input.priority ?? "normal",
            status: input.status ?? "idea",
            desiredQuantity: positiveInteger(input.desiredQuantity ?? 1, "desiredQuantity"),
            ...(input.notes ? { notes: nonBlank(input.notes, "notes") } : {}),
            tags: normalizeTags(input.tags),
            createdAt: now,
            updatedAt: now,
        };
        if (!WISHLIST_PRIORITIES.includes(item.priority) || !WISHLIST_STATUSES.includes(item.status)) {
            throw new WishlistValidationError("invalid priority or status");
        }
        this.database.createWishlistItem(item);
        return this.requireDetail(item.id);
    }
    update(itemId, input) {
        this.requireDetail(itemId);
        this.database.updateWishlistItem(itemId, {
            ...(input.name !== undefined ? { name: nonBlank(input.name, "name") } : {}),
            ...(input.category !== undefined ? { category: optionalText(input.category, "category") } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.desiredQuantity !== undefined
                ? { desiredQuantity: positiveInteger(input.desiredQuantity, "desiredQuantity") }
                : {}),
            ...(input.notes !== undefined ? { notes: optionalText(input.notes, "notes") } : {}),
            ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
            updatedAt: this.now().toISOString(),
        });
        return this.requireDetail(itemId);
    }
    transition(itemId, toStatus, reason) {
        if (!WISHLIST_STATUSES.includes(toStatus))
            throw new WishlistValidationError("invalid wishlist status");
        const current = this.requireDetail(itemId);
        if (current.status === toStatus)
            throw new WishlistValidationError(`item is already ${toStatus}`);
        this.database.transitionWishlistItem({
            itemId,
            fromStatus: current.status,
            toStatus,
            reason: reason ? nonBlank(reason, "reason") : undefined,
            occurredAt: this.now().toISOString(),
        });
        return this.requireDetail(itemId);
    }
    status(filters = {}) {
        if (filters.itemId) {
            const detail = this.database.getWishlistItemDetail(filters.itemId);
            return detail ? [detail] : [];
        }
        return this.database.listWishlistItemDetails({
            ...filters,
            ...(filters.category ? { category: nonBlank(filters.category, "category") } : {}),
            ...(filters.tag ? { tag: nonBlank(filters.tag, "tag").toLowerCase() } : {}),
            ...(filters.query ? { query: nonBlank(filters.query, "query") } : {}),
            limit: Math.min(100, Math.max(1, Math.floor(filters.limit ?? 50))),
        });
    }
    addLink(itemId, input) {
        this.requireDetail(itemId);
        const kind = input.kind ?? "reference";
        if (!WISHLIST_LINK_KINDS.includes(kind))
            throw new WishlistValidationError("invalid link kind");
        const now = this.now().toISOString();
        this.database.createWishlistLink({
            id: randomUUID(), itemId, url: absoluteHttpUrl(input.url), kind,
            ...(input.label ? { label: nonBlank(input.label, "label") } : {}),
            ...(input.price !== undefined ? { price: nonnegative(input.price, "price") } : {}),
            ...(input.currency ? { currency: nonBlank(input.currency, "currency").toUpperCase() } : {}),
            createdAt: now, updatedAt: now,
        });
        return this.requireDetail(itemId);
    }
    removeLink(itemId, linkId) {
        this.requireDetail(itemId);
        if (!this.database.removeWishlistLink(itemId, linkId))
            throw new WishlistValidationError(`unknown link ID ${linkId}`);
        return this.requireDetail(itemId);
    }
    addPurchase(itemId, input) {
        this.requireDetail(itemId);
        const now = this.now().toISOString();
        this.database.createWishlistPurchase({
            id: randomUUID(), itemId,
            quantity: positiveInteger(input.quantity ?? 1, "quantity"),
            ...(input.unitPrice !== undefined ? { unitPrice: nonnegative(input.unitPrice, "unitPrice") } : {}),
            ...(input.currency ? { currency: nonBlank(input.currency, "currency").toUpperCase() } : {}),
            ...(input.seller ? { seller: nonBlank(input.seller, "seller") } : {}),
            purchasedAt: dateOnly(input.purchasedAt ?? this.now().toISOString().slice(0, 10)),
            ...(input.notes ? { notes: nonBlank(input.notes, "notes") } : {}),
            createdAt: now, updatedAt: now,
        });
        return this.requireDetail(itemId);
    }
    updatePurchase(itemId, purchaseId, input) {
        this.requireDetail(itemId);
        if (!this.database.getWishlistPurchase(itemId, purchaseId))
            throw new WishlistValidationError(`unknown purchase ID ${purchaseId}`);
        this.database.updateWishlistPurchase(itemId, purchaseId, {
            ...(input.quantity !== undefined ? { quantity: positiveInteger(input.quantity, "quantity") } : {}),
            ...(input.unitPrice !== undefined
                ? { unitPrice: input.unitPrice === null ? null : nonnegative(input.unitPrice, "unitPrice") }
                : {}),
            ...(input.currency !== undefined ? { currency: optionalText(input.currency, "currency")?.toUpperCase() ?? null } : {}),
            ...(input.seller !== undefined ? { seller: optionalText(input.seller, "seller") } : {}),
            ...(input.purchasedAt !== undefined ? { purchasedAt: dateOnly(input.purchasedAt) } : {}),
            ...(input.notes !== undefined ? { notes: optionalText(input.notes, "notes") } : {}),
            updatedAt: this.now().toISOString(),
        });
        return this.requireDetail(itemId);
    }
    deletePurchase(itemId, purchaseId) {
        this.requireDetail(itemId);
        if (!this.database.removeWishlistPurchase(itemId, purchaseId))
            throw new WishlistValidationError(`unknown purchase ID ${purchaseId}`);
        return this.requireDetail(itemId);
    }
    attachMonitor(itemId, kind, watchId) {
        this.requireDetail(itemId);
        this.database.attachWishlistMonitor(itemId, kind, watchId, this.now().toISOString());
        return this.requireDetail(itemId);
    }
    detachMonitor(itemId, kind, watchId) {
        this.requireDetail(itemId);
        if (!this.database.detachWishlistMonitor(itemId, kind, watchId)) {
            throw new WishlistValidationError("monitor association does not exist");
        }
        return this.requireDetail(itemId);
    }
    summary() {
        const items = this.database.listWishlistItemDetails({ includeArchived: false, limit: 10_000 });
        const byStatus = {};
        const byPriority = {};
        const spendingByCurrency = {};
        for (const item of items) {
            byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
            byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
            for (const purchase of item.purchases) {
                if (purchase.unitPrice === undefined)
                    continue;
                const currency = purchase.currency ?? "unspecified";
                spendingByCurrency[currency] = Math.round(((spendingByCurrency[currency] ?? 0) + purchase.unitPrice * purchase.quantity) * 100) / 100;
            }
        }
        return {
            total: items.length, byStatus, byPriority,
            watching: items.filter((item) => item.watching).length,
            desiredUnits: items.reduce((sum, item) => sum + item.desiredQuantity, 0),
            acquiredUnits: items.reduce((sum, item) => sum + item.acquiredQuantity, 0),
            spendingByCurrency,
        };
    }
    requireDetail(itemId) {
        const item = this.database.getWishlistItemDetail(itemId);
        if (!item)
            throw new WishlistValidationError(`unknown wishlist item ID ${itemId}`);
        return item;
    }
}
