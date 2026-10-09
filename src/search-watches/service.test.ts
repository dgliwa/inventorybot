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
  it("discovers an adapter before persisting and queues only newly seen results", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client, () => new Date("2026-01-01T00:00:00.000Z"));
    try {
      client.results = [{
        url: "https://www.costco.com/magic-the-gathering-box.product.1.html?utm_source=test",
        title: "Magic: Gathering Box",
      }];
      const watch = await service.add({ domain: "costco.com", query: "magic gathering" });
      expect(watch).toMatchObject({
        domain: "costco.com",
        cadenceMinutes: 60,
        adapter: { queryParameter: "keyword" },
      });
      await expect(service.run(watch.id, {
        notification: { channel: "discord", target: "channel:123" },
      })).resolves.toMatchObject({ baselineEstablished: true, notificationsRecommended: 0 });

      client.results.push({
        url: "https://www.costco.com/magic-the-gathering-bundle.product.2.html",
        title: "Magic The Gathering Bundle",
      });
      await expect(service.run(watch.id, {
        notification: { channel: "discord", target: "channel:123" },
      })).resolves.toMatchObject({
        matchedResults: 2,
        notificationsRecommended: 1,
        newResults: [{ url: "https://www.costco.com/magic-the-gathering-bundle.product.2.html" }],
      });
      expect(database.notificationStatus()).toMatchObject({ pending: 1 });
    } finally {
      database.close();
    }
  });

  it("creates no watch when adapter discovery fails", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    client.discover.mockRejectedValueOnce(new Error("no search form"));
    const service = new SearchWatchService(database, client);
    try {
      await expect(service.add({ domain: "example.com", query: "cards" })).rejects.toThrow("no search form");
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
      const updated = await service.update({ watchId: watch.id, query: "pokemon", cadenceMinutes: 30 });
      expect(updated).toMatchObject({ query: "pokemon", cadenceMinutes: 30 });
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
});
