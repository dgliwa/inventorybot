import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../adapters/registry.js";
import { InventoryDatabase } from "../persistence/db.js";
import { WatchService } from "../watches/service.js";
import { WishlistService } from "./service.js";

describe("WishlistService", () => {
  const create = () => {
    const database = new InventoryDatabase(":memory:");
    const service = new WishlistService(database, () => new Date("2026-10-14T12:00:00.000Z"));
    return { database, service };
  };

  it("creates a quiet generic idea with normalized tags", () => {
    const { database, service } = create();
    try {
      const item = service.add({
        name: "  Cordless shop vacuum  ",
        category: "Tools",
        tags: ["Garage", "garage", "Home Improvement"],
      });
      expect(item).toMatchObject({
        name: "Cordless shop vacuum",
        category: "Tools",
        priority: "normal",
        status: "idea",
        desiredQuantity: 1,
        acquiredQuantity: 0,
        watching: false,
        displayState: "idea · no monitoring",
        tags: ["garage", "home improvement"],
      });
      expect(item.monitors).toEqual([]);
      expect(item.transitions).toMatchObject([{ toStatus: "idea", reason: "Item created" }]);
    } finally {
      database.close();
    }
  });

  it("records lifecycle transitions independently from monitoring", () => {
    const { database, service } = create();
    try {
      const item = service.add({ name: "Book" });
      const wanted = service.transition(item.id, "researching", "Compare editions");
      expect(wanted.status).toBe("researching");
      expect(wanted.transitions[0]).toMatchObject({
        fromStatus: "idea",
        toStatus: "researching",
        reason: "Compare editions",
      });
      expect(wanted.watching).toBe(false);
    } finally {
      database.close();
    }
  });

  it("stores links without creating monitors", () => {
    const { database, service } = create();
    try {
      const item = service.add({ name: "Dehumidifier" });
      const updated = service.addLink(item.id, {
        url: "https://example.com/product#reviews",
        kind: "review",
        label: "Long-term review",
        price: 199.99,
        currency: "usd",
      });
      expect(updated.links[0]).toMatchObject({
        url: "https://example.com/product",
        kind: "review",
        currency: "USD",
      });
      expect(updated.monitors).toEqual([]);
      expect(service.removeLink(item.id, updated.links[0].id).links).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("derives acquired and remaining quantities from correctable purchases", () => {
    const { database, service } = create();
    try {
      const item = service.add({ name: "Commander deck", desiredQuantity: 2, status: "wanted" });
      let detail = service.addPurchase(item.id, {
        quantity: 1,
        unitPrice: 89.99,
        currency: "usd",
        seller: "Costco",
        purchasedAt: "2026-10-13",
      });
      expect(detail).toMatchObject({ acquiredQuantity: 1, remainingQuantity: 1 });
      const purchaseId = detail.purchases[0].id;
      detail = service.updatePurchase(item.id, purchaseId, { quantity: 2, notes: "Two kits" });
      expect(detail).toMatchObject({ acquiredQuantity: 2, remainingQuantity: 0 });
      expect(service.summary()).toMatchObject({
        total: 1,
        desiredUnits: 2,
        acquiredUnits: 2,
        spendingByCurrency: { USD: 179.98 },
      });
      expect(service.deletePurchase(item.id, purchaseId)).toMatchObject({
        acquiredQuantity: 0,
        remainingQuantity: 2,
      });
    } finally {
      database.close();
    }
  });

  it("attaches existing watches without changing their enabled state", () => {
    const { database, service } = create();
    try {
      const item = service.add({ name: "Example synth", status: "wanted" });
      const watch = new WatchService(database, new AdapterRegistry()).add({
        product: { name: "Example synth" },
        retailers: [{ url: "https://shop.example.test/synth" }],
        enabled: true,
      });
      const attached = service.attachMonitor(item.id, "inventory", watch.id);
      expect(attached).toMatchObject({ watching: true, displayState: "wanted · watching" });
      expect(attached.monitors).toEqual([{ kind: "inventory", watchId: watch.id, enabled: true }]);
      expect(database.getWatch(watch.id)?.enabled).toBe(true);
      expect(service.detachMonitor(item.id, "inventory", watch.id).watching).toBe(false);
      expect(database.getWatch(watch.id)?.enabled).toBe(true);
    } finally {
      database.close();
    }
  });

  it("filters items and excludes archived items by default", () => {
    const { database, service } = create();
    try {
      service.add({ name: "Vacuum", category: "Tools", priority: "high", tags: ["garage"] });
      const book = service.add({ name: "Design book", category: "Books", tags: ["reading"] });
      service.transition(book.id, "archived");
      expect(service.status()).toHaveLength(1);
      expect(service.status({ query: "vac", tag: "garage", priority: "high" })[0].name).toBe("Vacuum");
      expect(service.status({ includeArchived: true })).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("rejects invalid values and unknown monitor IDs", () => {
    const { database, service } = create();
    try {
      const item = service.add({ name: "Thing" });
      expect(() => service.update(item.id, { desiredQuantity: 0 })).toThrow("positive integer");
      expect(() => service.addLink(item.id, { url: "file:///tmp/item" })).toThrow("HTTP(S)");
      expect(() => service.addPurchase(item.id, { purchasedAt: "not-a-date" })).toThrow("YYYY-MM-DD");
      expect(() => service.attachMonitor(item.id, "search", "missing")).toThrow("Unknown search watch");
    } finally {
      database.close();
    }
  });
});
