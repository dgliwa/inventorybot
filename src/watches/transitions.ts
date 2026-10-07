import type { InventoryStatus } from "../domain/inventory.js";
import type { InventoryTransition } from "./types.js";

export function detectInventoryTransition(
  previousStatus: InventoryStatus | undefined,
  currentStatus: InventoryStatus,
  options: { notifyWhenUnavailable?: boolean } = {},
): InventoryTransition {
  const changed = previousStatus !== currentStatus;
  const becameAvailable = currentStatus === "in_stock" && previousStatus !== "in_stock";
  const becameUnavailable =
    options.notifyWhenUnavailable === true &&
    previousStatus === "in_stock" &&
    currentStatus === "out_of_stock";

  return {
    previousStatus,
    currentStatus,
    changed,
    notifyRecommended: changed && (becameAvailable || becameUnavailable),
  };
}
