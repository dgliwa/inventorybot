import { describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../discovery/types.js";
import { InventoryDatabase } from "../persistence/db.js";
import { SearchWatchService } from "./service.js";
import type { DeterministicSearchAdapter, DeterministicSearchClient } from "./types.js";

const adapter: DeterministicSearchAdapter = {
  version: 1,
  kind: "html_get",
  domain: "costco.com",
  searchUrl: "https://www.costco.com/search",
  queryParameter: "keyword",
  fixedParameters: {},
  parser: "html_links",
  validatedAt: "2026-01-01T00:00:00.000Z",
  validationResultCount: 1,
};

class MutableSearchClient implements DeterministicSearchClient {
  results: SearchResult[] = [];
  readonly discover = vi.fn(async (domain: string) => ({
    adapter: { ...adapter, domain },
    results: this.results,
  }));
  readonly search = vi.fn(async () => this.results);
}

describe("SearchWatchService", () => {
  it("discovers an adapter and records only newly seen results for the digest", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client, () => new Date("2026-01-01T00:00:00.000Z"));
    try {
      client.results = [{
        url: "https://www.costco.com/magic-the-gathering-box.product.1.html?utm_source=test",
        title: "Magic Gathering Box",
      }];
      const watch = await service.add({
        domain: "costco.com",
        query: "magic gathering",
        notifyOnInitialResults: false,
      });
      expect(watch).toMatchObject({ domain: "costco.com", cadenceMinutes: 60 });
      await expect(service.run(watch.id)).resolves.toMatchObject({
        baselineEstablished: true,
        notificationsRecommended: 0,
      });
      expect(database.listPendingSearchDiscoveryEvents()).toHaveLength(0);

      client.results.push({
        url: "https://www.costco.com/magic-the-gathering-bundle.product.2.html",
        title: "Magic The Gathering Bundle",
      });
      await expect(service.run(watch.id)).resolves.toMatchObject({
        matchedResults: 2,
        notificationsRecommended: 0,
        newResults: [{ url: "https://www.costco.com/magic-the-gathering-bundle.product.2.html" }],
      });
      expect(database.notificationStatus()).toMatchObject({ pending: 0 });
      expect(database.listPendingSearchDiscoveryEvents()).toMatchObject([
        { kind: "new", present: true },
      ]);
    } finally {
      database.close();
    }
  });

  it("records initial matching results by default", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client);
    try {
      client.results = [{ url: "https://costco.com/magic-box", title: "Magic Gathering Box" }];
      const watch = await service.add({ domain: "costco.com", query: "magic gathering" });
      await expect(service.run(watch.id)).resolves.toMatchObject({
        baselineEstablished: true,
        notificationsRecommended: 0,
      });
      expect(database.listPendingSearchDiscoveryEvents()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("does not persist a watch when adapter discovery fails", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    client.discover.mockRejectedValueOnce(new Error("no adapter"));
    const service = new SearchWatchService(database, client);
    try {
      await expect(service.add({ domain: "example.com", query: "synth" })).rejects.toThrow("no adapter");
      expect(database.listSearchWatches()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rediscovers the adapter and resets results when the query changes", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client);
    try {
      const watch = await service.add({ domain: "costco.com", query: "magic gathering" });
      client.results = [{ url: "https://costco.com/magic-gathering", title: "Magic Gathering" }];
      await service.run(watch.id);
      const updated = await service.update({ watchId: watch.id, query: "pokemon", cadenceMinutes: 60 });
      expect(updated).toMatchObject({ query: "pokemon", cadenceMinutes: 60 });
      expect(updated).not.toHaveProperty("lastCheckedAt");
      expect(database.listSearchWatchResults(watch.id)).toEqual([]);
      expect(client.discover).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("filters other domains and unrelated results", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client);
    try {
      const watch = await service.add({ domain: "costco.com", query: "magic the gathering" });
      client.results = [
        { url: "https://example.com/magic-the-gathering", title: "Magic the Gathering" },
        { url: "https://costco.com/pokemon", title: "Pokemon cards" },
      ];
      await expect(service.run(watch.id, { dryRun: true })).resolves.toMatchObject({
        matchedResults: 0,
        newResults: [],
      });
    } finally {
      database.close();
    }
  });

  it("backs off repeated failures and resets after a successful check", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new SearchWatchService(database, client, () => now);
    try {
      const watch = await service.add({ domain: "costco.com", query: "magic gathering" });
      database.deferSearchWatchAfterFailure(watch.id, now.toISOString(), 60, "HTTP 429");
      expect(database.getSearchWatch(watch.id)).toMatchObject({
        consecutiveFailures: 1,
        lastError: "HTTP 429",
        nextCheckAt: "2026-01-01T01:00:00.000Z",
      });

      now = new Date("2026-01-01T01:00:00.000Z");
      database.deferSearchWatchAfterFailure(watch.id, now.toISOString(), 60, "HTTP 429");
      expect(database.getSearchWatch(watch.id)).toMatchObject({
        consecutiveFailures: 2,
        nextCheckAt: "2026-01-01T03:00:00.000Z",
      });

      client.results = [{ url: "https://costco.com/magic-box", title: "Magic Box" }];
      await service.run(watch.id);
      expect(database.getSearchWatch(watch.id)).toMatchObject({ consecutiveFailures: 0 });
      expect(database.getSearchWatch(watch.id)?.lastError).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("records a returned listing only after confirmed absence", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new SearchWatchService(database, client, () => now);
    try {
      const watch = await service.add({ domain: "costco.com", query: "magic gathering" });
      client.results = [{ url: "https://costco.com/magic-gathering-box", title: "Magic Gathering Box" }];
      await service.run(watch.id);
      expect(database.listPendingSearchDiscoveryEvents()).toHaveLength(1);

      client.results = [];
      for (const hour of [1, 2, 3]) {
        now = new Date(`2026-01-01T${String(hour).padStart(2, "0")}:00:00.000Z`);
        await service.run(watch.id);
      }
      now = new Date("2026-01-02T04:00:00.000Z");
      client.results = [{ url: "https://costco.com/magic-gathering-box", title: "Magic Gathering Box" }];
      await expect(service.run(watch.id)).resolves.toMatchObject({
        newResults: [{ reappeared: true }],
      });
      expect(database.listPendingSearchDiscoveryEvents()).toMatchObject([
        { kind: "new" },
        { kind: "returned" },
      ]);
    } finally {
      database.close();
    }
  });
});
