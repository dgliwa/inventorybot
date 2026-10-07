import type { InventoryResult } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
export type InventoryCheckContext = {
    expectedProduct?: ProductIdentity;
    timeoutMs?: number;
    signal?: AbortSignal;
};
export interface RetailerAdapter {
    id: string;
    version: string;
    domains: string[];
    canHandle(url: string): boolean;
    checkInventory(url: string, context?: InventoryCheckContext): Promise<InventoryResult>;
}
