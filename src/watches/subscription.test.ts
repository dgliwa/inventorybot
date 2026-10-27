import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../adapters/registry.js";
import type { InventoryCheckContext, RetailerAdapter } from "../adapters/types.js";
import { normalizeInventoryResult } from "../domain/inventory.js";
import { InventoryDatabase } from "../persistence/db.js";
import { RetailerSubscriptionService } from "../retailers/subscriptions.js";
import { WatchService } from "./service.js";

class SubscriptionAdapter implements RetailerAdapter {
  readonly id = "subscription";
  readonly version = "1";
  readonly domains = ["shop.example.test"];
  readonly check = vi.fn(async (url: string, context?: InventoryCheckContext) => normalizeInventoryResult({
    status: "in_stock",
    confidence: 1,
    domain: "shop.example.test",
    url,
    method: "public_api",
    fulfillment: {
      shipping: { status: "available", orderableOnline: true },
      stores: (context?.retailerSubscription?.stores ?? []).map((store) => ({
        storeId: store.storeId,
        name: store.name,
        stock: "in_stock" as const,
        pickupOrderable: true,
        walkInAvailable: true,
      })),
    },
    evidence: { summary: "Fixture fulfillment response." },
  }));

  canHandle(url: string): boolean {
    return new URL(url).hostname === "shop.example.test";
  }

  checkInventory(url: string, context?: InventoryCheckContext) {
    return this.check(url, context);
  }
}

describe("exact watches with retailer subscriptions", () => {
  it("passes location and store preferences to the retailer adapter", async () => {
    const database = new InventoryDatabase(":memory:");
    const adapter = new SubscriptionAdapter();
    const service = new WatchService(database, new AdapterRegistry([adapter]));
    try {
      const subscription = new RetailerSubscriptionService(database).add({
        domain: "shop.example.test",
        postalCode: "55125",
        stores: [{ storeId: "42", name: "Oakdale" }],
      });
      const watch = service.add({
        product: { sku: "SKU-42" },
        retailers: [{
          url: "https://shop.example.test/product/42",
          retailerSubscriptionId: subscription.id,
        }],
      });
      expect(watch.retailers[0]).toMatchObject({ retailerSubscriptionId: subscription.id });
      await service.run(watch.id);
      expect(adapter.check).toHaveBeenCalledWith(
        "https://shop.example.test/product/42",
        expect.objectContaining({
          retailerSubscription: expect.objectContaining({
            postalCode: "55125",
            stores: [{ storeId: "42", name: "Oakdale", primary: true }],
          }),
        }),
      );
      expect(service.status(watch.id)).toMatchObject({
        retailers: [{
          latestResult: {
            fulfillment: {
              shipping: { status: "available", orderableOnline: true },
              stores: [{ storeId: "42", pickupOrderable: true }],
            },
          },
        }],
      });
    } finally {
      database.close();
    }
  });

  it("rejects a subscription from a different retailer", () => {
    const database = new InventoryDatabase(":memory:");
    const service = new WatchService(database, new AdapterRegistry([]));
    try {
      const subscription = new RetailerSubscriptionService(database).add({
        domain: "target.com",
        postalCode: "55125",
      });
      expect(() => service.add({
        product: { sku: "SKU-42" },
        retailers: [{
          url: "https://bestbuy.com/product/42",
          retailerSubscriptionId: subscription.id,
        }],
      })).toThrow("RETAILER_SUBSCRIPTION_DOMAIN_MISMATCH");
    } finally {
      database.close();
    }
  });
});
