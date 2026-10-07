import { describe, expect, it, vi } from "vitest";
import type { RetailerAdapter } from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { normalizeInventoryResult, type InventoryStatus } from "../domain/inventory.js";
import { InventoryDatabase } from "../persistence/db.js";
import { WatchService } from "./service.js";
import { detectInventoryTransition } from "./transitions.js";

class SequenceAdapter implements RetailerAdapter {
  readonly id = "sequence-adapter";
  readonly version = "1.0.0";
  readonly domains = ["shop.example.test"];
  #index = 0;

  constructor(private readonly statuses: InventoryStatus[]) {}

  canHandle(url: string): boolean {
    return new URL(url).hostname.endsWith("shop.example.test");
  }

  async checkInventory(url: string) {
    const status = this.statuses[Math.min(this.#index++, this.statuses.length - 1)];
    return normalizeInventoryResult({
      status,
      confidence: 0.99,
      domain: new URL(url).hostname,
      url,
      method: "public_api",
      evidence: { summary: `Fixture status: ${status}` },
    });
  }
}

class ThrowingAdapter implements RetailerAdapter {
  readonly id = "throwing-adapter";
  readonly version = "1.0.0";
  readonly domains = ["broken.example.test"];

  canHandle(url: string): boolean {
    return new URL(url).hostname === "broken.example.test";
  }

  async checkInventory(): Promise<never> {
    throw new Error("fixture adapter failure");
  }
}

function createService(statuses: InventoryStatus[] = ["in_stock"]) {
  const database = new InventoryDatabase(":memory:");
  const logs: unknown[] = [];
  const registry = new AdapterRegistry([new SequenceAdapter(statuses)]);
  const service = new WatchService(database, registry, (record) => logs.push(record));
  return { database, service, logs };
}

describe("detectInventoryTransition", () => {
  it("notifies on availability and suppresses repeated in-stock results", () => {
    expect(detectInventoryTransition("out_of_stock", "in_stock")).toMatchObject({
      changed: true,
      notifyRecommended: true,
    });
    expect(detectInventoryTransition("in_stock", "in_stock")).toMatchObject({
      changed: false,
      notifyRecommended: false,
    });
    expect(detectInventoryTransition("in_stock", "out_of_stock")).toMatchObject({
      changed: true,
      notifyRecommended: false,
    });
    expect(
      detectInventoryTransition("in_stock", "out_of_stock", { notifyWhenUnavailable: true }),
    ).toMatchObject({ changed: true, notifyRecommended: true });
  });
});

describe("WatchService", () => {
  it("persists a normalized watch and deduplicates retailer URLs", () => {
    const { database, service } = createService();
    try {
      const watch = service.add({
        product: { name: "Test Product", sku: "SKU-42" },
        retailers: [
          { url: "https://shop.example.test/product/42#stock" },
          { url: "https://shop.example.test/product/42" },
        ],
      });
      expect(watch.product).toEqual({ name: "Test Product", sku: "SKU-42" });
      expect(watch.retailers).toHaveLength(1);
      expect(watch.retailers[0]).toMatchObject({
        adapterReady: true,
        adapterId: "sequence-adapter",
        adapterVersion: "1.0.0",
      });
      expect(service.status(watch.id)).toMatchObject({ id: watch.id, enabled: true });
      expect(service.status()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("records observations and suppresses repeated available notifications", async () => {
    const { database, service, logs } = createService(["in_stock", "in_stock"]);
    try {
      const watch = service.add({
        product: { sku: "SKU-42" },
        retailers: [{ url: "https://shop.example.test/product/42?token=secret" }],
      });
      const first = await service.run(watch.id);
      const second = await service.run(watch.id);

      expect(first.summary).toEqual({
        checked: 1,
        available: 1,
        requiresInspection: 0,
        notificationsRecommended: 1,
      });
      expect(second.summary.notificationsRecommended).toBe(0);
      expect(second.targets[0].transition).toMatchObject({
        previousStatus: "in_stock",
        changed: false,
      });
      expect(service.status(watch.id)).toMatchObject({
        retailers: [{ latestResult: { status: "in_stock" } }],
      });
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        adapter_id: "sequence-adapter",
        adapter_version: "1.0.0",
        status: "in_stock",
        url: "https://shop.example.test/product/42",
      });
    } finally {
      database.close();
    }
  });

  it("isolates unsupported retailers and marks them for inspection", async () => {
    const { database, service } = createService(["out_of_stock"]);
    try {
      const watch = service.add({
        product: { sku: "SKU-42" },
        retailers: [
          { url: "https://shop.example.test/product/42" },
          { url: "https://unsupported.example/product/42" },
        ],
      });
      const run = await service.run(watch.id);
      expect(run.summary).toMatchObject({ checked: 2, requiresInspection: 1 });
      expect(run.targets.map(({ result }) => result.status).sort()).toEqual([
        "out_of_stock",
        "unknown",
      ]);
      expect(run.targets.find(({ requiresInspection }) => requiresInspection)).toMatchObject({
        requiresInspection: true,
        result: { error: { code: "UNSUPPORTED_RETAILER" } },
      });
    } finally {
      database.close();
    }
  });

  it("does not let one throwing adapter abort the watch run", async () => {
    const database = new InventoryDatabase(":memory:");
    const registry = new AdapterRegistry([
      new ThrowingAdapter(),
      new SequenceAdapter(["in_stock"]),
    ]);
    const service = new WatchService(database, registry);
    try {
      const watch = service.add({
        product: { sku: "SKU-42" },
        retailers: [
          { url: "https://broken.example.test/product/42" },
          { url: "https://shop.example.test/product/42" },
        ],
      });
      const run = await service.run(watch.id);
      expect(run.summary.checked).toBe(2);
      expect(run.targets.map(({ result }) => result.status).sort()).toEqual(["error", "in_stock"]);
      expect(run.targets.find(({ result }) => result.status === "error")).toMatchObject({
        requiresInspection: true,
        result: { error: { code: "ADAPTER_FAILED" } },
      });
    } finally {
      database.close();
    }
  });

  it("honors scheduler cancellation before starting a target", async () => {
    const { database, service } = createService();
    try {
      const watch = service.add({
        product: { sku: "SKU-42" },
        retailers: [{ url: "https://shop.example.test/product/42" }],
      });
      const controller = new AbortController();
      controller.abort();
      await expect(service.run(watch.id, { signal: controller.signal })).rejects.toThrow();
      const status = service.status(watch.id);
      expect(status && !Array.isArray(status) ? status.retailers[0].latestResult : null)
        .toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("does not mutate watches after invocation cancellation", () => {
    const { database, service } = createService();
    const controller = new AbortController();
    controller.abort();
    try {
      expect(() => service.add({
        product: { sku: "SKU-42" },
        retailers: [{ url: "https://shop.example.test/product/42" }],
      }, { signal: controller.signal })).toThrow();
      expect(service.status()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("disables by default and permanently removes only when requested", () => {
    const { database, service } = createService();
    try {
      const watch = service.add({
        product: { sku: "SKU-42" },
        retailers: [{ url: "https://shop.example.test/product/42" }],
      });
      expect(service.remove(watch.id)).toEqual({
        watchId: watch.id,
        disabled: true,
        removed: false,
      });
      expect(service.status(watch.id)).toMatchObject({ enabled: false });
      expect(service.remove(watch.id, { permanent: true })).toEqual({
        watchId: watch.id,
        disabled: false,
        removed: true,
      });
      expect(service.status(watch.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("can require active adapter coverage before creating a watch", () => {
    const { database, service } = createService();
    try {
      expect(() => service.add({
        product: { upc: "123456789012" },
        retailers: [{ url: "https://unsupported.example/product/42" }],
        requireActiveAdapter: true,
      })).toThrow("NO_ACTIVE_ADAPTER");
      expect(service.status()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects empty products and retailer lists", () => {
    const { database, service } = createService();
    try {
      expect(() => service.add({ product: {}, retailers: [] })).toThrow("retailer");
      expect(() => service.add({ product: {}, retailers: [{ url: "https://shop.example.test/p" }] }))
        .toThrow("product identity");
    } finally {
      database.close();
    }
  });
});
