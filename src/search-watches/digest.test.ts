import { describe, expect, it } from "vitest";
import { formatInventoryNotification } from "../notifications/discord.js";
import { InventoryDatabase } from "../persistence/db.js";
import { DiscoveryDigestService } from "./digest.js";
import { SearchWatchService } from "./service.js";
import type { DeterministicSearchClient } from "./types.js";

const client: DeterministicSearchClient = {
  async discover(domain) {
    return {
      adapter: {
        version: 1,
        kind: "html_get",
        domain,
        searchUrl: `https://${domain}/search`,
        queryParameter: "q",
        fixedParameters: {},
        parser: "html_links",
        validatedAt: "2026-01-01T00:00:00.000Z",
        validationResultCount: 1,
      },
      results: [],
    };
  },
  async search() {
    return [{ url: "https://example.com/product/1", title: "Magic Gathering Box" }];
  },
};

describe("DiscoveryDigestService", () => {
  it("queues one daily notification and marks accumulated events digested", async () => {
    const database = new InventoryDatabase(":memory:");
    try {
      const search = new SearchWatchService(database, client, () => new Date("2026-01-01T08:00:00.000Z"));
      const watch = await search.add({ domain: "example.com", query: "magic gathering" });
      await search.run(watch.id);
      const [listing] = database.listSearchWatchResults(watch.id);
      database.recordSearchDiscoveryEvents({
        watchId: watch.id,
        results: [{ ...listing!, reappeared: true }],
        observedAt: "2026-01-01T08:30:00.000Z",
      });
      expect(database.listPendingSearchDiscoveryEvents()).toHaveLength(2);

      const digest = new DiscoveryDigestService(database, () => new Date(2026, 0, 1, 9));
      expect(digest.run({ target: { channel: "discord", target: "channel:123" } })).toEqual({
        localDate: "2026-01-01",
        alreadyCompleted: false,
        events: 2,
        notificationQueued: true,
      });
      expect(database.listPendingSearchDiscoveryEvents()).toHaveLength(0);
      expect(database.notificationStatus()).toMatchObject({ pending: 1 });
      expect(digest.run({ target: { channel: "discord", target: "channel:123" } })).toMatchObject({
        alreadyCompleted: true,
        events: 0,
        notificationQueued: false,
      });
      const [notification] = database.claimNotifications({
        now: "2026-01-02T00:00:00.000Z",
        limit: 10,
        leaseMs: 1_000,
      });
      expect(notification?.payload).toMatchObject({
        kind: "discovery_digest",
        discoveryGroups: [{
          retailerDomain: "example.com",
          searchQuery: "magic gathering",
          results: [{
            availability: "not_checked",
            present: true,
            discoveryKind: "returned",
            activityCount: 2,
            firstObservedAt: "2026-01-01T08:00:00.000Z",
            observedAt: "2026-01-01T08:30:00.000Z",
          }],
        }],
      });
      expect(formatInventoryNotification(notification!.payload)).toContain("2 discovery changes today");
    } finally {
      database.close();
    }
  });

  it("waits until the configured local digest hour", () => {
    const database = new InventoryDatabase(":memory:");
    try {
      const digest = new DiscoveryDigestService(database, () => new Date(2026, 0, 1, 8));
      expect(digest.run({ digestHourLocal: 9 })).toMatchObject({
        alreadyCompleted: false,
        events: 0,
        notificationQueued: false,
      });
      expect(database.hasDiscoveryDigestRun("2026-01-01")).toBe(false);
    } finally {
      database.close();
    }
  });
});
