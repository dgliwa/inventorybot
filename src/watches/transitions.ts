import type { InventoryResult, InventoryStatus } from "../domain/inventory.js";
import type { InventoryTransition } from "./types.js";

function actionableFulfillment(result: InventoryResult | undefined): Set<string> {
  const actions = new Set<string>();
  const fulfillment = result?.fulfillment;
  if (!fulfillment) return actions;
  if (fulfillment.shipping.status === "available" && fulfillment.shipping.orderableOnline === true) {
    actions.add("shipping");
  }
  if (fulfillment.delivery?.status === "available" && fulfillment.delivery.orderableOnline === true) {
    actions.add("delivery");
  }
  for (const store of fulfillment.stores) {
    if (store.pickupOrderable === true) actions.add(`pickup:${store.storeId}`);
    if (
      store.walkInAvailable === true &&
      (store.stock === "in_stock" || store.stock === "limited")
    ) actions.add(`walk_in:${store.storeId}`);
  }
  return actions;
}

export function detectInventoryResultTransition(
  previous: InventoryResult | undefined,
  current: InventoryResult,
  options: { notifyWhenUnavailable?: boolean } = {},
): InventoryTransition {
  const statusTransition = detectInventoryTransition(previous?.status, current.status, options);
  const previousActions = actionableFulfillment(previous);
  const currentActions = actionableFulfillment(current);
  const gainedAction = [...currentActions].some((action) => !previousActions.has(action));
  const lostAction = [...previousActions].some((action) => !currentActions.has(action));
  return {
    ...statusTransition,
    changed: statusTransition.changed || gainedAction || lostAction,
    notifyRecommended: statusTransition.notifyRecommended || gainedAction,
  };
}

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
