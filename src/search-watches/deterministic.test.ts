import { describe, expect, it, vi } from "vitest";
import { DirectRetailerSearchClient, SearchAdapterDiscoveryError } from "./deterministic.js";

const resolver = async () => ["93.184.216.34"];

function response(url: string, html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html" },
  });
}

describe("DirectRetailerSearchClient", () => {
  it("discovers a GET search form and validates stable product links", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://shop.example.com/") {
        return response(url, `
          <html><form role="search" method="get" action="/catalog">
            <input type="hidden" name="category" value="all">
            <input type="search" name="keyword">
          </form></html>
        `);
      }
      return response(url, `
        <html><a class="product" href="/products/magic-box">Magic the Gathering Box</a></html>
      `);
    });
    const client = new DirectRetailerSearchClient(fetchImpl, resolver, () => new Date("2026-01-01T00:00:00.000Z"));
    const result = await client.discover("shop.example.com", "magic the gathering");
    expect(result.adapter).toMatchObject({
      domain: "shop.example.com",
      searchUrl: "https://shop.example.com/catalog",
      queryParameter: "keyword",
      fixedParameters: { category: "all" },
      validationResultCount: 1,
    });
    expect(result.results).toEqual([{
      url: "https://shop.example.com/products/magic-box",
      title: "Magic the Gathering Box",
    }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects sites without a deterministic GET search form", async () => {
    const client = new DirectRetailerSearchClient(
      async (input) => response(String(input), "<html><button>Open search</button></html>"),
      resolver,
    );
    await expect(client.discover("example.com", "cards")).rejects.toMatchObject({
      code: "SEARCH_FORM_NOT_FOUND",
    });
  });

  it("rejects blocked search pages", async () => {
    const client = new DirectRetailerSearchClient(
      async (input) => response(String(input), "Access denied", 403),
      resolver,
    );
    await expect(client.discover("example.com", "cards")).rejects.toBeInstanceOf(SearchAdapterDiscoveryError);
  });
});
