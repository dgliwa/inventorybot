import { describe, expect, it, vi } from "vitest";
import { inspectRetailerStatic, type StaticFetch } from "./static.js";
import { assertPublicHttpUrl } from "./url-safety.js";

const publicResolver = vi.fn(async () => ["93.184.216.34"]);
const responseFetch = (body: string, status = 200, headers?: HeadersInit): StaticFetch =>
  vi.fn(async () => new Response(body, { status, headers }));

const jsonLdPage = (availability = "https://schema.org/InStock", sku = "SKU-42") => `
<html><head><script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Acme Product",
  "sku": "${sku}",
  "offers": {
    "@type": "Offer",
    "availability": "${availability}",
    "price": "25.50",
    "priceCurrency": "USD"
  }
}
</script></head></html>`;

const inspectWith = (httpFetch: StaticFetch, expectedProduct = { sku: "SKU-42" }) =>
  inspectRetailerStatic("https://unknown-shop.example/products/42", {
    expectedProduct,
    httpFetch,
    resolveHost: publicResolver,
  });

describe("inspectRetailerStatic", () => {
  it("prefers JSON-LD and returns reusable observations", async () => {
    await expect(inspectWith(responseFetch(jsonLdPage()))).resolves.toMatchObject({
      level: "static",
      finalUrl: "https://unknown-shop.example/products/42",
      product: { name: "Acme Product", sku: "SKU-42" },
      inventory: {
        status: "in_stock",
        confidence: 0.98,
        price: 25.5,
        currency: "USD",
        method: "json_ld",
      },
      observations: [
        { source: "json_ld", field: "product", value: true },
        { source: "json_ld", field: "availability", value: "https://schema.org/InStock" },
      ],
      sanitizedFixture: {
        kind: "json_ld",
        html: expect.stringContaining("application/ld+json"),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      nextRecommendedLevel: "none",
      adapterReadiness: "ready_for_generation",
      identityVerified: true,
      nextAction: expect.stringContaining("Generate"),
    });
  });

  it("returns unknown on a product mismatch", async () => {
    await expect(inspectWith(responseFetch(jsonLdPage()), { sku: "WRONG" })).resolves.toMatchObject({
      inventory: {
        status: "unknown",
        productMatchConfidence: 0,
        error: { code: "PRODUCT_MISMATCH" },
      },
      nextRecommendedLevel: "none",
      adapterReadiness: "product_mismatch",
      identityVerified: false,
    });
  });

  it("uses unambiguous HTML labels at lower confidence", async () => {
    const html = "<html><title>Acme SKU-42</title><main>SKU-42 — Currently out of stock</main></html>";
    await expect(inspectWith(responseFetch(html))).resolves.toMatchObject({
      inventory: { status: "out_of_stock", confidence: 0.7, method: "html" },
      nextRecommendedLevel: "none",
    });
  });

  it("returns unknown and recommends network inspection for missing or ambiguous stock", async () => {
    const missing = "<html><title>Acme SKU-42</title><main>SKU-42 details</main></html>";
    await expect(inspectWith(responseFetch(missing))).resolves.toMatchObject({
      inventory: { status: "unknown", error: { code: "PARSE_ERROR" } },
      nextRecommendedLevel: "network",
    });

    const ambiguous = "<html><title>SKU-42</title>SKU-42 in stock; related item sold out</html>";
    await expect(inspectWith(responseFetch(ambiguous))).resolves.toMatchObject({
      inventory: { status: "unknown" },
      nextRecommendedLevel: "network",
    });
  });

  it.each([
    [403, "blocked", "BLOCKED"],
    [404, "error", "PAGE_NOT_FOUND"],
  ])("maps HTTP %i safely", async (httpStatus, status, code) => {
    await expect(inspectWith(responseFetch("response", httpStatus))).resolves.toMatchObject({
      inventory: { status, error: { code } },
      nextRecommendedLevel: "none",
    });
  });

  it("detects CAPTCHA pages without attempting bypass", async () => {
    await expect(inspectWith(responseFetch("<html>Verify you are human CAPTCHA</html>"))).resolves.toMatchObject({
      inventory: { status: "blocked", error: { code: "CAPTCHA" } },
      adapterReadiness: "blocked",
      identityVerified: false,
    });
  });

  it("validates every redirect target", async () => {
    const httpFetch = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "/new-product" } }))
      .mockResolvedValueOnce(new Response(jsonLdPage(), { status: 200 }));
    const result = await inspectWith(httpFetch);
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(result.finalUrl).toBe("https://unknown-shop.example/new-product");
  });

  it("rejects oversized responses", async () => {
    const oversized = responseFetch("small test body", 200, { "content-length": "3000000" });
    await expect(inspectWith(oversized)).resolves.toMatchObject({
      inventory: { status: "error", error: { code: "RESPONSE_TOO_LARGE" } },
    });
  });

  it("returns an explicit timeout", async () => {
    const neverFetch: StaticFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      inspectRetailerStatic("https://unknown-shop.example/item", {
        timeoutMs: 1,
        httpFetch: neverFetch,
        resolveHost: publicResolver,
      }),
    ).resolves.toMatchObject({ inventory: { status: "error", error: { code: "TIMEOUT" } } });
  });

  it("blocks local and private targets before fetching", async () => {
    const httpFetch = responseFetch("should not be fetched");
    const result = await inspectRetailerStatic("http://internal.example/secrets", {
      httpFetch,
      resolveHost: async () => ["127.0.0.1"],
    });
    expect(httpFetch).not.toHaveBeenCalled();
    expect(result.inventory).toMatchObject({ status: "blocked", error: { code: "BLOCKED_URL" } });
  });
});

describe("assertPublicHttpUrl", () => {
  it("rejects credentials and non-HTTP protocols", async () => {
    await expect(assertPublicHttpUrl("https://user:pass@example.com/p", publicResolver)).rejects.toThrow("credentials");
    await expect(assertPublicHttpUrl("file:///etc/passwd", publicResolver)).rejects.toThrow("HTTP");
  });
});
