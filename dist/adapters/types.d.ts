import type { InventoryResult } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
import type { RetailerSubscription } from "../retailers/types.js";
export type InventoryCheckContext = {
    expectedProduct?: ProductIdentity;
    timeoutMs?: number;
    signal?: AbortSignal;
    retailerSubscription?: RetailerSubscription;
};
export interface RetailerAdapter {
    id: string;
    version: string;
    domains: string[];
    canHandle(url: string): boolean;
    checkInventory(url: string, context?: InventoryCheckContext): Promise<InventoryResult>;
}
