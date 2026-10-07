import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { DurableMessageBatchSendResult } from "openclaw/plugin-sdk/channel-outbound";
import { AdapterRegistry } from "../adapters/registry.js";
import type { RetailerAdapter } from "../adapters/types.js";
import { normalizeInventoryResult } from "../domain/inventory.js";
import { InventoryDatabase } from "../persistence/db.js";
import { WatchService } from "../watches/service.js";
import { NotificationDispatcher } from "./dispatcher.js";
import { formatInventoryNotification, OpenClawDiscordChannel } from "./discord.js";
import type { NotificationChannel } from "./types.js";

class AvailableAdapter implements RetailerAdapter {
  readonly id = "available";
  readonly version = "1.0.0";
  readonly domains = ["shop.example.test"];
  canHandle(url: string): boolean {
    return new URL(url).hostname === "shop.example.test";
  }
  async checkInventory(url: string) {
    return normalizeInventoryResult({
      status: "in_stock",
      confidence: 0.99,
      method: "json_ld",
      domain: "shop.example.test",
      url,
      price: 42,
      currency: "USD",
      checkedAt: "2026-01-01T00:00:00.000Z",
      evidence: { summary: "Fixture availability." },
    });
  }
}

describe("notification outbox", () => {
  it("queues a transition atomically, delivers it, and suppresses a repeated state", async () => {
    const database = new InventoryDatabase(":memory:");
    const watchService = new WatchService(
      database,
      new AdapterRegistry([new AvailableAdapter()]),
    );
    const send = vi.fn(async () => ({
      status: "delivered" as const,
      providerMessageId: "discord-message-1",
    }));
    const channel: NotificationChannel = { id: "discord", send };
    try {
      const watch = watchService.add({
        product: { name: "Fixture Product", sku: "FIX-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
      const notification = { channel: "discord", target: "channel:123" };
      await watchService.run(watch.id, { notification });
      expect(database.notificationStatus()).toMatchObject({ pending: 1, sent: 0 });

      const result = await new NotificationDispatcher(
        database,
        new Map([["discord", channel]]),
      ).dispatch();
      expect(result).toEqual({
        claimed: 1,
        sent: 1,
        handedOff: 0,
        suppressed: 0,
        failed: 0,
        terminal: 0,
      });
      expect(send).toHaveBeenCalledOnce();
      expect(database.notificationStatus()).toMatchObject({ pending: 0, sent: 1 });

      await watchService.run(watch.id, { notification });
      expect(database.notificationStatus()).toMatchObject({ pending: 0, sent: 1 });
    } finally {
      database.close();
    }
  });

  it("stops local retries after OpenClaw accepts durable custody", async () => {
    const database = new InventoryDatabase(":memory:");
    const service = new WatchService(
      database,
      new AdapterRegistry([new AvailableAdapter()]),
    );
    const channel: NotificationChannel = {
      id: "discord",
      send: vi.fn(async () => ({
        status: "handed_off" as const,
        durableIntentId: "openclaw-intent-1",
        error: "provider result was ambiguous",
      })),
    };
    try {
      const watch = service.add({
        product: { sku: "FIX-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
      await service.run(watch.id, {
        notification: { channel: "discord", target: "channel:123" },
      });
      const result = await new NotificationDispatcher(
        database,
        new Map([["discord", channel]]),
      ).dispatch();
      expect(result).toMatchObject({ claimed: 1, handedOff: 1, failed: 0 });
      expect(database.notificationStatus()).toMatchObject({
        pending: 0,
        processing: 0,
        handedOff: 1,
      });
      expect(await new NotificationDispatcher(
        database,
        new Map([["discord", channel]]),
      ).dispatch()).toMatchObject({ claimed: 0 });
    } finally {
      database.close();
    }
  });

  it("returns failures before durable custody to the local retry queue", async () => {
    const database = new InventoryDatabase(":memory:");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const service = new WatchService(
      database,
      new AdapterRegistry([new AvailableAdapter()]),
      () => undefined,
      () => now,
    );
    const channel: NotificationChannel = {
      id: "discord",
      send: vi.fn(async () => { throw new Error("temporary outage"); }),
    };
    try {
      const watch = service.add({
        product: { sku: "FIX-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
      await service.run(watch.id, {
        notification: { channel: "discord", target: "channel:123" },
      });
      const result = await new NotificationDispatcher(
        database,
        new Map([["discord", channel]]),
        { maxAttempts: 3, baseRetryMs: 1_000 },
        () => now,
      ).dispatch();
      expect(result).toMatchObject({ claimed: 1, failed: 1, terminal: 0 });
      expect(database.notificationStatus().pending).toBe(1);
    } finally {
      database.close();
    }
  });
});

describe("OpenClawDiscordChannel", () => {
  it("hands delivery to OpenClaw's durable queue with a stable intent", async () => {
    const durableSend = vi.fn(async (params: {
      onDeliveryIntent?: (intent: { id: string }) => void;
    }): Promise<DurableMessageBatchSendResult> => {
      params.onDeliveryIntent?.({ id: "intent-42" });
      return {
        status: "sent",
        results: [{ channel: "discord", messageId: "message-42" }],
        receipt: { platformMessageIds: ["message-42"] },
      } as DurableMessageBatchSendResult;
    });
    const channel = new OpenClawDiscordChannel(
      {} as OpenClawConfig,
      { durableSend: durableSend as never },
    );
    await expect(channel.send({
      id: 1,
      fingerprint: "test",
      channel: "discord",
      target: "channel:123",
      accountId: "work",
      threadId: "thread-1",
      attemptCount: 1,
      payload: {
        kind: "test",
        productName: "InventoryBot",
        currentStatus: "test",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    })).resolves.toEqual({
      status: "delivered",
      providerMessageId: "message-42",
      durableIntentId: "intent-42",
    });
    expect(durableSend).toHaveBeenCalledWith(expect.objectContaining({
      channel: "discord",
      to: "channel:123",
      accountId: "work",
      threadId: "thread-1",
      durability: "required",
      deliveryIntentId: "inventorybot:test",
      reusePendingDeliveryIntent: true,
    }));
  });

  it("treats an existing stable intent as handed off when no live send occurs", async () => {
    const durableSend = vi.fn(async (): Promise<DurableMessageBatchSendResult> => ({
      status: "suppressed",
      results: [],
      receipt: { platformMessageIds: [] },
      reason: "no_visible_result",
    } as DurableMessageBatchSendResult));
    const channel = new OpenClawDiscordChannel(
      {} as OpenClawConfig,
      { durableSend: durableSend as never },
    );
    await expect(channel.send({
      id: 2,
      fingerprint: "already-queued",
      channel: "discord",
      target: "channel:123",
      attemptCount: 2,
      payload: {
        kind: "test",
        productName: "InventoryBot",
        currentStatus: "test",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    })).resolves.toEqual({
      status: "handed_off",
      durableIntentId: "inventorybot:already-queued",
    });
  });

  it("reports OpenClaw custody instead of retrying an accepted failed send", async () => {
    const durableSend = vi.fn(async (params: {
      onDeliveryIntent?: (intent: { id: string }) => void;
    }): Promise<DurableMessageBatchSendResult> => {
      params.onDeliveryIntent?.({ id: "intent-pending" });
      return { status: "failed", stage: "platform_send", error: new Error("ambiguous") };
    });
    const channel = new OpenClawDiscordChannel(
      {} as OpenClawConfig,
      { durableSend: durableSend as never },
    );
    await expect(channel.send({
      id: 2,
      fingerprint: "pending",
      channel: "discord",
      target: "channel:123",
      attemptCount: 1,
      payload: {
        kind: "test",
        productName: "InventoryBot",
        currentStatus: "test",
        checkedAt: "2026-01-01T00:00:00.000Z",
      },
    })).resolves.toEqual({
      status: "handed_off",
      durableIntentId: "intent-pending",
      error: "ambiguous",
    });
  });
});

describe("formatInventoryNotification", () => {
  it("formats transition evidence without losing the retailer URL", () => {
    expect(formatInventoryNotification({
      kind: "inventory_transition",
      productName: "Fixture Product",
      productSku: "FIX-42",
      retailerDomain: "shop.example.test",
      url: "https://shop.example.test/products/42",
      previousStatus: "out_of_stock",
      currentStatus: "in_stock",
      confidence: 0.99,
      checkedAt: "2026-01-01T00:00:00.000Z",
    })).toContain("out_of_stock → in_stock");
  });
});
