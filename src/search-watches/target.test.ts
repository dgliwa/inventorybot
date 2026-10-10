import { describe, expect, it, vi } from "vitest";
import { DirectRetailerSearchClient } from "./deterministic.js";
import { discoverTargetConfig, searchTarget } from "./target.js";

const endpoint = "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2";
const config = { services: { redskyAggregations: { baseUrl: "https://redsky.target.com", apiKey: "a".repeat(40),
  apis: { product: { endpointPaths: { plpSearchV2: endpoint } } } } } };
const location = { serverLocationVariables: { store_id: "2079" } };
const apiHtml = '<script>JSON.parse(' + JSON.stringify(JSON.stringify(config)) + ')</script>';
const html = apiHtml + '<script>JSON.parse(' + JSON.stringify(JSON.stringify(location)) + ')</script>';
const adapter = discoverTargetConfig(html, new Date("2026-01-01"));
const resolver = async () => ["93.184.216.34"];
const product = (id: number, title = "Magic: The Gathering Bundle", url = "https://www.target.com/p/bundle/-/A-" + id) =>
  ({ item: { product_description: { title }, enrichment: { buy_url: url } } });
const json = (products: unknown[], total = products.length) => new Response(JSON.stringify({ data: { search: {
  products, search_response: { metadata: { total_results: total } },
} } }), { headers: { "content-type": "application/json" } });

describe("Target public catalog search", () => {
  it("discovers configuration and validates repeated matches instead of the empty GET form", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => String(input).includes("redsky.target.com")
      ? json([product(123)]) : new Response(html + '<form><input name="searchTerm" type="search"></form>', { headers: { 'content-type': 'text/html' } }));
    const result = await new DirectRetailerSearchClient(fetchImpl, resolver).discover("target.com", "magic the gathering");
    expect(result.adapter).toMatchObject({ kind: "target_redsky", pricingStoreId: "2079", validationResultCount: 1 });
    expect(result.results[0].url).toBe("https://www.target.com/p/-/A-123");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("rejects changed or absent configuration", () => {
    expect(() => discoverTargetConfig("<script>alert(1)</script>", new Date())).toThrow(/configuration/);
    expect(() => discoverTargetConfig(apiHtml, new Date())).toThrow(/configuration/);
    expect(() => discoverTargetConfig(html.replaceAll("redsky.target.com", "evil.example"), new Date())).toThrow(/configuration/);
  });
  it("filters unrelated and unsafe links and deduplicates TCINs across slugs and tracking", async () => {
    const results = await searchTarget(adapter, "magic the gathering", 50, async () => json([
      product(123), product(123, undefined, "/p/new-slug/-/A-123?ref=test#details"), product(2, "Pokemon"),
      product(3, undefined, "https://evil.example/p/-/A-3"), product(4, undefined, "http://target.com/p/-/A-4"),
      product(5, undefined, "https://user:pass@target.com/p/-/A-5"), product(6, undefined, "/s?searchTerm=magic"), null,
    ]), resolver);
    expect(results).toHaveLength(1);
  });
  it("paginates with bounded offsets and stops at the result limit", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return json(Array.from({ length: 24 }, (_, i) => product(offset + i)), 1000);
    });
    expect(await searchTarget(adapter, "magic the gathering", 50, fetchImpl, resolver)).toHaveLength(50);
    expect(fetchImpl.mock.calls.map(([u]) => new URL(String(u)).searchParams.get("offset"))).toEqual(["0", "24", "48"]);
    const parameters = new URL(String(fetchImpl.mock.calls[0][0])).searchParams;
    expect(parameters.get("pricing_store_id")).toBe("2079");
    expect(parameters.get("visitor_id")).toBe("0000000000000000000000000000000000");
  });
  it("bounds pagination even when nothing matches", async () => {
    const fetchImpl = vi.fn(async () => json(Array.from({ length: 24 }, (_, i) => product(i, "Pokemon")), 1000));
    expect(await searchTarget(adapter, "magic the gathering", 50, fetchImpl, resolver)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("stops at total count and handles legitimate empty pages", async () => {
    const fetchImpl = vi.fn(async () => json(Array.from({ length: 24 }, (_, i) => product(i)), 24));
    expect(await searchTarget(adapter, "magic", 50, fetchImpl, resolver)).toHaveLength(24);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await searchTarget(adapter, "magic", 50, async () => json([]), resolver)).toEqual([]);
  });
  it.each([401, 403, 429, 435])("reports access blocking at HTTP %s without retry", async status => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status }));
    await expect(searchTarget(adapter, "magic", 50, fetchImpl, resolver)).rejects.toMatchObject({ code: "SEARCH_SITE_BLOCKED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("rejects schema drift and malformed JSON rather than reporting an empty catalog", async () => {
    for (const body of ['{}', 'not JSON']) await expect(searchTarget(adapter, "magic", 50,
      async () => new Response(body), resolver)).rejects.toMatchObject({ code: "SEARCH_RESULTS_NOT_PARSEABLE" });
  });
  it("rejects redirects, private DNS and altered stored endpoints", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: "http://localhost" } }));
    await expect(searchTarget(adapter, "magic", 50, fetchImpl, resolver)).rejects.toMatchObject({ code: "SEARCH_HTTP_ERROR" });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    fetchImpl.mockClear();
    await expect(searchTarget(adapter, "magic", 50, fetchImpl, async () => ["127.0.0.1"])).rejects.toThrow(/private/);
    await expect(searchTarget({ ...adapter, searchUrl: "https://evil.example" }, "magic", 50, fetchImpl, resolver)).rejects.toThrow(/configuration/);
    await expect(searchTarget({ ...adapter, pricingStoreId: "bad" }, "magic", 50, fetchImpl, resolver)).rejects.toThrow(/configuration/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("bounds response size", async () => {
    await expect(searchTarget(adapter, "magic", 50, async () => new Response("{}", {
      headers: { "content-length": "5000001" },
    }), resolver)).rejects.toMatchObject({ code: "SEARCH_RESPONSE_TOO_LARGE" });
  });
  it("does not validate an empty search", async () => {
    const client = new DirectRetailerSearchClient(async input => String(input).includes("redsky") ? json([]) : new Response(html, { headers: { 'content-type': 'text/html' } }), resolver);
    await expect(client.discover("target.com", "magic")).rejects.toMatchObject({ code: "SEARCH_RESULTS_NOT_PARSEABLE" });
  });
});
