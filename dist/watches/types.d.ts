import type { InventoryResult, InventoryStatus } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
export type InventoryWatchTarget = {
    id: string;
    domain: string;
    url: string;
    enabled: boolean;
    latestResult?: InventoryResult;
    adapterReady?: boolean;
    adapterId?: string;
    adapterVersion?: string;
};
export type InventoryWatch = {
    id: string;
    productId: string;
    product: ProductIdentity;
    retailers: InventoryWatchTarget[];
    createdAt: string;
    lastDiscoveryAt?: string;
    enabled: boolean;
};
export type InventoryTransition = {
    previousStatus?: InventoryStatus;
    currentStatus: InventoryStatus;
    changed: boolean;
    notifyRecommended: boolean;
};
export type WatchTargetRun = {
    targetId: string;
    domain: string;
    url: string;
    adapterId?: string;
    adapterVersion?: string;
    result: InventoryResult;
    transition: InventoryTransition;
    requiresInspection: boolean;
    durationMs: number;
};
export type WatchRun = {
    watchId: string;
    startedAt: string;
    completedAt: string;
    targets: WatchTargetRun[];
    summary: {
        checked: number;
        available: number;
        requiresInspection: number;
        notificationsRecommended: number;
    };
};
