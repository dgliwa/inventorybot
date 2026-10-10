import { describe, expect, it, vi } from "vitest";
import { createBestBuyAdapter, parseBestBuyResults, searchBestBuy } from "./bestbuy.js";
import { DirectRetailerSearchClient } from "./deterministic.js";

const resolver = async () => ["93.184.216.34"];
const adapter = createBestBuyAdapter(new Date("2026-01-01T00:00:00.000Z"));

function product(title: string, id = "JJ8VP7HLRV", slug = "magic-the-gathering-bundle"): string {
  return `<article><a href="https://www.bestbuy.com/product/${slug}/${id}"><h3>${title}</h3></a></article>`;
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(`<html><head><title>Best Buy Search</title></head><body>${body}</body></html>`, {
    status,
    headers: { "content-type": "text/html", ...headers },
  });
}

describe("Best Buy public HTML search", () => {
  it("discovers the bounded adapter and validates a stable product URL", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/") return html("Best Buy");
      return url.searchParams.get("cp") === "1"
        ? html(product("Magic The Gathering Bundle"))
        : html("No more results");
    });

    const result = await new DirectRetailerSearchClient(fetchImpl, resolver).discover(
      "bestbuy.com",
      "magic gathering",
    );

    expect(result.adapter).toMatchObject({
      kind: "bestbuy_html",
      parser: "bestbuy_search_html",
      validationResultCount: 1,
    });
    expect(result.results).toEqual([{
      title: "Magic The Gathering Bundle",
      url: "https://www.bestbuy.com/product/magic-the-gathering-bundle/JJ8VP7HLRV",
    }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("parses current and legacy product links while rejecting unsafe URLs", () => {
    const results = parseBestBuyResults(`
      ${product("Magic &amp; Gathering Bundle")}
      <a href="https://www.bestbuy.com/product/magic-the-gathering-bundle/JJ8VP7HLRV#reviews">Duplicate</a>
      <a href="/site/magic-gathering-box/1234567.p?skuId=1234567">Magic Gathering Box</a>
      <a href="http://www.bestbuy.com/product/magic-set/ABCDEF1234">Magic Gathering HTTP</a>
      <a href="https://user:pass@www.bestbuy.com/product/magic-set/ABCDEF1234">Magic Gathering credentials</a>
      <a href="https://evil.example/product/magic-set/ABCDEF1234">Magic Gathering off domain</a>
      <a href="https://www.bestbuy.com/site/searchpage.jsp?st=magic">Magic Gathering search</a>
    `, "magic gathering");

    expect(results).toEqual([
      {
        title: "Magic & Gathering Bundle",
        url: "https://www.bestbuy.com/product/magic-the-gathering-bundle/JJ8VP7HLRV",
      },
      {
        title: "Magic Gathering Box",
        url: "https://www.bestbuy.com/site/-/1234567.p?skuId=1234567",
      },
    ]);
  });

  it("bounds pagination and result count", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("cp"));
      return html(Array.from({ length: 24 }, (_, index) =>
        product(`Magic Gathering Item ${page}-${index}`, `SKU${page}${String(index).padStart(7, "0")}`),
      ).join(""));
    });

    const results = await searchBestBuy(adapter, "magic gathering", 50, fetchImpl, resolver);
    expect(results).toHaveLength(50);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("cp")))
      .toEqual(["1", "2", "3"]);
  });

  it("stops when a page adds no products and supports empty results", async () => {
    const fetchImpl = vi.fn(async () => html("No matching products"));
    await expect(searchBestBuy(adapter, "magic gathering", 50, fetchImpl, resolver)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 435])("reports access blocking at HTTP %s", async (status) => {
    await expect(searchBestBuy(adapter, "magic", 50, async () => html("denied", status), resolver))
      .rejects.toMatchObject({ code: "SEARCH_SITE_BLOCKED" });
  });

  it("rejects challenge pages, redirects, private addresses, and modified configuration", async () => {
    await expect(searchBestBuy(adapter, "magic", 50, async () =>
      new Response("<title>Verify you are human</title>"), resolver))
      .rejects.toMatchObject({ code: "SEARCH_SITE_BLOCKED" });
    await expect(searchBestBuy(adapter, "magic", 50, async () =>
      new Response("redirect", { status: 302, headers: { location: "https://evil.example" } }), resolver))
      .rejects.toMatchObject({ code: "SEARCH_HTTP_ERROR" });
    await expect(searchBestBuy(adapter, "magic", 50, vi.fn(), async () => ["127.0.0.1"]))
      .rejects.toThrow(/private/i);
    await expect(searchBestBuy({ ...adapter, searchUrl: "https://evil.example/search" } as typeof adapter,
      "magic", 50, vi.fn(), resolver)).rejects.toThrow(/configuration/i);
  });

  it("enforces the bounded response size", async () => {
    await expect(searchBestBuy(adapter, "magic", 50, async () => new Response("", {
      headers: { "content-length": "5000001" },
    }), resolver)).rejects.toMatchObject({ code: "SEARCH_RESPONSE_TOO_LARGE" });
  });
});
