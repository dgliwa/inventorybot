import { describe, expect, it } from "vitest";
import { InventoryDatabase } from "../persistence/db.js";
import { RetailerSubscriptionService } from "./subscriptions.js";

describe("RetailerSubscriptionService", () => {
  it("stores location and preferred-store settings", () => {
    const database = new InventoryDatabase(":memory:");
    const service = new RetailerSubscriptionService(
      database,
      () => new Date("2026-01-01T00:00:00.000Z"),
    );
    try {
      const subscription = service.add({
        domain: "bestbuy.com",
        postalCode: "55125",
        radiusMiles: 20,
        stores: [
          { storeId: "10", name: "Oakdale" },
          { storeId: "20", name: "Maplewood" },
        ],
      });
      expect(subscription).toMatchObject({
        domain: "bestbuy.com",
        postalCode: "55125",
        radiusMiles: 20,
        enabled: true,
        stores: [
          { storeId: "10", name: "Oakdale", primary: true },
          { storeId: "20", name: "Maplewood", primary: false },
        ],
      });
      expect(service.status(subscription.id)).toEqual(subscription);
      expect(service.update({
        subscriptionId: subscription.id,
        stores: [{ storeId: "20", name: "Maplewood", primary: true }],
      })).toMatchObject({ stores: [{ storeId: "20", primary: true }] });
      expect(service.remove(subscription.id)).toBe(true);
      expect(service.status(subscription.id)).toMatchObject({ enabled: false });
    } finally {
      database.close();
    }
  });

  it("rejects more than one primary store", () => {
    const database = new InventoryDatabase(":memory:");
    try {
      const service = new RetailerSubscriptionService(database);
      expect(() => service.add({
        domain: "target.com",
        postalCode: "55125",
        stores: [
          { storeId: "1", name: "One", primary: true },
          { storeId: "2", name: "Two", primary: true },
        ],
      })).toThrow("only one primary store");
    } finally {
      database.close();
    }
  });
});
