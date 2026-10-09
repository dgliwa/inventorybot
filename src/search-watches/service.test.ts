import { describe, expect, it, vi } from "vitest";
import type { RetailerSearchClient, SearchResult } from "../discovery/types.js";
import { InventoryDatabase } from "../persistence/db.js";
import { SearchWatchService } from "./service.js";

class MutableSearchClient implements RetailerSearchClient {
  results: SearchResult[] = [];
  readonly search = vi.fn(async () => this.results);
}

describe("SearchWatchService", () => {
  it("establishes a silent baseline and queues only newly seen matching URLs", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client, () => new Date("2026-01-01T00:00:00.000Z"));
    try {
      const watch = service.add({ domain: "costco.com", query: "magic the gathering" });
      expect(watch).toMatchObject({
        domain: "costco.com",
        query: "magic the gathering",
        cadenceMinutes: 60,
        notifyOnInitialResults: false,
      });
      client.results = [{
        url: "https://www.costco.com/magic-the-gathering-box.product.1.html?utm_source=test",
        title: "Magic: The Gathering Box",
      }];
      await expect(service.run(watch.id, {
        notification: { channel: "discord", target: "channel:123" },
      })).resolves.toMatchObject({
        matchedResults: 1,
        baselineEstablished: true,
        notificationsRecommended: 0,
      });

      client.results.push({
        url: "https://www.costco.com/magic-the-gathering-bundle.product.2.html",
        title: "Magic The Gathering Bundle",
      });
      await expect(service.run(watch.id, {
        notification: { channel: "discord", target: "channel:123" },
      })).resolves.toMatchObject({
        matchedResults: 2,
        baselineEstablished: false,
        notificationsRecommended: 1,
        newResults: [{ url: "https://www.costco.com/magic-the-gathering-bundle.product.2.html" }],
      });
      expect(database.notificationStatus()).toMatchObject({ pending: 1 });
    } finally {
      database.close();
    }
  });

  it("edits cadence and resets results when the search changes", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client);
    try {
      const watch = service.add({
        domain: "costco.com",
        query: "magic the gathering",
        cadenceMinutes: 60,
      });
      client.results = [{
        url: "https://www.costco.com/magic-the-gathering.product.1.html",
        title: "Magic the Gathering",
      }];
      await service.run(watch.id);
      expect(database.listSearchWatchResults(watch.id)).toHaveLength(1);

      const updated = service.update({
        watchId: watch.id,
        query: "pokemon",
        cadenceMinutes: 30,
      });
      expect(updated).toMatchObject({ query: "pokemon", cadenceMinutes: 30 });
      expect(updated).not.toHaveProperty("lastCheckedAt");
      expect(database.listSearchWatchResults(watch.id)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("strips OpenClaw trust wrappers and opaque snippet placeholders", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client);
    try {
      const watch = service.add({ domain: "costco.com", query: "magic the gathering" });
      client.results = [{
        url: "https://costco.com/magic-the-gathering.product.1.html",
        title: "<<<EXTERNAL_UNTRUSTED_CONTENT id=\"abc\">>>\nSource: Web Search\n---\nMagic: The Gathering Bundle | Costco\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\"abc\">>>",
        snippet: "<<ccr:abc,string,500B>>",
      }];
      const result = await service.run(watch.id, { dryRun: true });
      expect(result.newResults[0]).toMatchObject({
        title: "Magic: The Gathering Bundle | Costco",
      });
      expect(result.newResults[0]).not.toHaveProperty("snippet");
    } finally {
      database.close();
    }
  });

  it("filters other domains and unrelated results", async () => {
    const database = new InventoryDatabase(":memory:");
    const client = new MutableSearchClient();
    const service = new SearchWatchService(database, client);
    try {
      const watch = service.add({ domain: "costco.com", query: "magic the gathering" });
      client.results = [
        { url: "https://example.com/magic-the-gathering", title: "Magic the Gathering" },
        { url: "https://costco.com/pokemon", title: "Pokemon cards" },
      ];
      await expect(service.run(watch.id, { dryRun: true })).resolves.toMatchObject({
        matchedResults: 0,
        newResults: [],
        dryRun: true,
      });
    } finally {
      database.close();
    }
  });
});
