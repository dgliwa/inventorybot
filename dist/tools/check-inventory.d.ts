import { type InventoryResult } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { RetailerSubscription } from "../retailers/types.js";
export type CheckInventoryInput = {
    url: string;
    expectedProduct?: ProductIdentity;
    timeoutMs?: number;
    signal?: AbortSignal;
    retailerSubscription?: RetailerSubscription;
};
export declare function checkInventory(input: CheckInventoryInput, registry: AdapterRegistry): Promise<InventoryResult>;
