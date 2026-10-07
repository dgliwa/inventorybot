import { describe, expect, it, vi } from "vitest";
import { discoverRetailers } from "./discover.js";
import { normalizeSearchResults } from "./openclaw-search.js";
import type { RetailerSearchClient } from "./types.js";

class FakeSearch implements RetailerSearchClient {
  readonly search = vi.fn(async () => [
    {
      url: "https://shop.example.com/products/synth?utm_source=search",
      title: "Acme SYNTH-42 Synthesizer",
      snippet: "Buy the Acme SYNTH-42 today",
    },
    {
      url: "https://shop.example.com/products/synth?utm_source=duplicate",
      title: "Acme SYNTH-42 Synthesizer",
    },
    { url: "https://youtube.com/watch/123", title: "SYNTH-42 review" },
    { url: "https://store.example.net/blog/synth-42-review", title: "Review" },
    { url: "not a URL", title: "Bad URL" },
  ]);
}

describe("discoverRetailers", () => {
  it("searches exact identifiers, rejects irrelevant pages, and deduplicates URLs", async () => {
    const search = new FakeSearch();
    const result = await discoverRetailers(
      { manufacturer: "Acme", sku: "SYNTH-42", upc: "123456789012" },
      search,
    );

    expect(search.search).toHaveBeenCalledTimes(2);
    expect(search.search.mock.calls[0][0]).toContain('"SYNTH-42"');
    expect(search.search.mock.calls[1][0]).toContain('"123456789012"');
    expect(result.candidates).toEqual([
      {
        domain: "shop.example.com",
        url: "https://shop.example.com/products/synth",
        confidence: 0.9,
        matchedBy: "sku",
        sellerType: "unknown",
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("uses the product name only when exact identifiers are unavailable", async () => {
    const search: RetailerSearchClient = { search: vi.fn(async () => []) };
    const result = await discoverRetailers(
      { name: "Example Synth", variant: "Black" },
      search,
    );
    expect(result.queries).toEqual(['"Example Synth" "Black" buy']);
  });

  it("preserves and normalizes a supplied source URL", async () => {
    const search: RetailerSearchClient = { search: vi.fn(async () => []) };
    const result = await discoverRetailers(
      { sourceUrl: "https://www.acme.com/item/42/?utm_medium=email#stock", manufacturer: "Acme" },
      search,
    );
    expect(result.candidates[0]).toEqual({
      domain: "acme.com",
      url: "https://www.acme.com/item/42",
      confidence: 1,
      matchedBy: "source_url",
      sellerType: "manufacturer",
    });
  });

  it("reports insufficient identity and search failures without throwing", async () => {
    const noIdentity = await discoverRetailers({}, { search: vi.fn(async () => []) });
    expect(noIdentity.errors[0]?.code).toBe("PRODUCT_IDENTITY_INSUFFICIENT");

    const failed = await discoverRetailers(
      { sku: "ABC" },
      { search: vi.fn(async () => { throw new Error("provider unavailable"); }) },
    );
    expect(failed.errors[0]).toMatchObject({ code: "DISCOVERY_SEARCH_FAILED" });
  });
});

describe("normalizeSearchResults", () => {
  it("normalizes common OpenClaw provider result shapes", () => {
    expect(normalizeSearchResults({
      data: { items: [{ link: "https://shop.test/p/1", name: "Product", description: "SKU 1" }] },
    })).toEqual([{ url: "https://shop.test/p/1", title: "Product", snippet: "SKU 1" }]);
  });
});
