import type { InventoryDatabase } from "../persistence/db.js";
import { type WishlistItemDetail, type WishlistLinkKind, type WishlistPriority, type WishlistStatus } from "./types.js";
export declare class WishlistValidationError extends Error {
    constructor(message: string);
}
export declare class WishlistService {
    private readonly database;
    private readonly now;
    constructor(database: InventoryDatabase, now?: () => Date);
    add(input: {
        name: string;
        category?: string;
        priority?: WishlistPriority;
        status?: WishlistStatus;
        desiredQuantity?: number;
        notes?: string;
        tags?: string[];
    }): WishlistItemDetail;
    update(itemId: string, input: {
        name?: string;
        category?: string | null;
        priority?: WishlistPriority;
        desiredQuantity?: number;
        notes?: string | null;
        tags?: string[];
    }): WishlistItemDetail;
    transition(itemId: string, toStatus: WishlistStatus, reason?: string): WishlistItemDetail;
    status(filters?: {
        itemId?: string;
        status?: WishlistStatus;
        priority?: WishlistPriority;
        category?: string;
        tag?: string;
        query?: string;
        includeArchived?: boolean;
        limit?: number;
    }): WishlistItemDetail[];
    addLink(itemId: string, input: {
        url: string;
        kind?: WishlistLinkKind;
        label?: string;
        price?: number;
        currency?: string;
    }): WishlistItemDetail;
    removeLink(itemId: string, linkId: string): WishlistItemDetail;
    addPurchase(itemId: string, input: {
        quantity?: number;
        unitPrice?: number;
        currency?: string;
        seller?: string;
        purchasedAt?: string;
        notes?: string;
    }): WishlistItemDetail;
    updatePurchase(itemId: string, purchaseId: string, input: {
        quantity?: number;
        unitPrice?: number | null;
        currency?: string | null;
        seller?: string | null;
        purchasedAt?: string;
        notes?: string | null;
    }): WishlistItemDetail;
    deletePurchase(itemId: string, purchaseId: string): WishlistItemDetail;
    attachMonitor(itemId: string, kind: "inventory" | "search", watchId: string): WishlistItemDetail;
    detachMonitor(itemId: string, kind: "inventory" | "search", watchId: string): WishlistItemDetail;
    summary(): {
        total: number;
        byStatus: Record<string, number>;
        byPriority: Record<string, number>;
        watching: number;
        desiredUnits: number;
        acquiredUnits: number;
        spendingByCurrency: Record<string, number>;
    };
    private requireDetail;
}
