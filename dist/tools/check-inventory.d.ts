import { type InventoryResult } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
import { AdapterRegistry } from "../adapters/registry.js";
export type CheckInventoryInput = {
    url: string;
    expectedProduct?: ProductIdentity;
    timeoutMs?: number;
    signal?: AbortSignal;
};
export declare function checkInventory(input: CheckInventoryInput, registry: AdapterRegistry): Promise<InventoryResult>;
