import type { InventoryResult, InventoryStatus } from "../domain/inventory.js";
import type { InventoryTransition } from "./types.js";
export declare function detectInventoryResultTransition(previous: InventoryResult | undefined, current: InventoryResult, options?: {
    notifyWhenUnavailable?: boolean;
}): InventoryTransition;
export declare function detectInventoryTransition(previousStatus: InventoryStatus | undefined, currentStatus: InventoryStatus, options?: {
    notifyWhenUnavailable?: boolean;
}): InventoryTransition;
