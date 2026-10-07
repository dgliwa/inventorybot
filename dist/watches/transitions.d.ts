import type { InventoryStatus } from "../domain/inventory.js";
import type { InventoryTransition } from "./types.js";
export declare function detectInventoryTransition(previousStatus: InventoryStatus | undefined, currentStatus: InventoryStatus, options?: {
    notifyWhenUnavailable?: boolean;
}): InventoryTransition;
