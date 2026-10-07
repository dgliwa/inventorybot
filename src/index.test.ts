import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";
import { ExampleJsonLdAdapter, type HttpFetch } from "./adapters/builtins/example-jsonld.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { domainMatches, normalizeDomain } from "./adapters/url.js";
import { normalizeInventoryResult } from "./domain/inventory.js";
import { matchProductIdentity } from "./domain/product.js";
import { checkInventory } from "./tools/check-inventory.js";

const productPage = (availability = "https://schema.org/InStock") => `
  <html><script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Example Synth Black",
    "sku": "SYNTH-42",
    "mpn": "M-42",
    "offers": {
      "@type": "Offer",
      "availability": "${availability}",
      "price": "499.99",
      "priceCurrency": "USD",
      "seller": { "name": "Example Retailer" }
    }
  }
  </script></html>`;

const fetchResponse = (body: string, status = 200): HttpFetch =>
  vi.fn(async () => new Response(body, { status }));

const checkWith = (httpFetch: HttpFetch, expectedProduct = { sku: "SYNTH-42" }) =>
  new ExampleJsonLdAdapter(httpFetch).checkInventory(
    "https://www.example-retailer.test/products/synth",
    { expectedProduct },
  );

describe("inventorybot plugin", () => {
  it("registers the Phase 6 tool surface in tool-discovery mode", () => {
    const names: string[] = [];
    entry.register?.({
      registrationMode: "tool-discovery",
      registerTool(tool: { name?: string } | ((context: unknown) => { name?: string })) {
        if (typeof tool !== "function" && tool.name) names.push(tool.name);
      },
    } as unknown as OpenClawPluginApi);
    expect(names).toEqual([
      "discover_retailers",
      "check_inventory",
      "inspect_retailer",
      "generate_retailer_adapter",
      "validate_retailer_adapter",
      "inventory_adapter_list",
      "inventory_adapter_approve",
      "inventory_adapter_revoke",
      "inventory_watch_add",
      "inventory_watch_remove",
      "inventory_watch_status",
      "inventory_watch_run",
      "inventory_monitor_status",
      "inventory_monitor_run_fast",
      "inventory_monitor_run_slow",
      "inventory_notification_test",
    ]);
  });

  it("registers the monitor service only during full activation", () => {
    const services: string[] = [];
    entry.register?.({
      registrationMode: "full",
      registerTool() {},
      registerService(service: { id: string }) { services.push(service.id); },
    } as unknown as OpenClawPluginApi);
    expect(services).toEqual(["inventorybot-monitor"]);
  });
});

describe("URL and registry behavior", () => {
  it("normalizes www and matches retailer subdomains without suffix confusion", () => {
    expect(normalizeDomain("https://WWW.Example-Retailer.test/item")).toBe(
      "example-retailer.test",
    );
    expect(domainMatches("shop.example-retailer.test", "example-retailer.test")).toBe(true);
    expect(domainMatches("example-retailer.test.evil.test", "example-retailer.test")).toBe(false);
  });

  it("looks up an adapter and rejects duplicate adapter IDs", () => {
    const adapter = new ExampleJsonLdAdapter(fetchResponse(productPage()));
    const registry = new AdapterRegistry([adapter]);
    expect(registry.get("https://shop.example-retailer.test/item")).toBe(adapter);
    expect(registry.get("https://unrelated.test/item")).toBeUndefined();
    expect(() => registry.register(adapter)).toThrow("already registered");
  });
});

describe("domain contracts", () => {
  it("clamps confidence and supplies a timestamp", () => {
    const result = normalizeInventoryResult({
      status: "unknown",
      confidence: 2,
      domain: "example.test",
      url: "https://example.test/item",
      method: "unknown",
      evidence: { summary: "No evidence." },
    });
    expect(result.confidence).toBe(1);
    expect(Number.isNaN(Date.parse(result.checkedAt))).toBe(false);
  });

  it("matches exact identifiers and rejects a wrong product", () => {
    expect(matchProductIdentity({ sku: "ABC-123" }, { sku: "abc123" }).matches).toBe(true);
    expect(matchProductIdentity({ mpn: "RIGHT" }, { mpn: "WRONG" })).toMatchObject({
      matches: false,
      confidence: 0,
    });
    expect(
      matchProductIdentity(
        { sku: "ABC-123", upc: "123456789012" },
        { sku: "ABC123" },
      ),
    ).toMatchObject({ matches: true, confidence: 0.5 });
    expect(matchProductIdentity({ sku: "ABC-123" }, {})).toMatchObject({
      matches: true,
      confidence: 0,
    });
  });
});

describe("ExampleJsonLdAdapter", () => {
  it("returns deterministic stock, price, identity, and evidence", async () => {
    await expect(checkWith(fetchResponse(productPage()))).resolves.toMatchObject({
      status: "in_stock",
      confidence: 0.98,
      domain: "example-retailer.test",
      productMatchConfidence: 1,
      price: 499.99,
      currency: "USD",
      sku: "SYNTH-42",
      seller: "Example Retailer",
      method: "json_ld",
      evidence: { raw: { availability: "https://schema.org/InStock" } },
    });
  });

  it("maps schema.org out-of-stock without inference", async () => {
    await expect(
      checkWith(fetchResponse(productPage("https://schema.org/OutOfStock"))),
    ).resolves.toMatchObject({ status: "out_of_stock", confidence: 0.98 });
  });

  it.each([
    ["malformed JSON-LD", "<script type='application/ld+json'>{oops}</script>", "unknown", "PARSE_ERROR"],
    ["missing stock", productPage("https://schema.org/Discontinued"), "unknown", "PARSE_ERROR"],
    ["CAPTCHA", "<html>Verify you are human: CAPTCHA</html>", "blocked", "CAPTCHA"],
  ])("handles %s safely", async (_name, html, status, code) => {
    await expect(checkWith(fetchResponse(html))).resolves.toMatchObject({
      status,
      error: { code },
    });
  });

  it("treats HTTP 403 as blocked", async () => {
    await expect(checkWith(fetchResponse("forbidden", 403))).resolves.toMatchObject({
      status: "blocked",
      error: { code: "BLOCKED" },
    });
  });

  it("returns unknown for the wrong product page", async () => {
    await expect(checkWith(fetchResponse(productPage()), { sku: "OTHER" })).resolves.toMatchObject({
      status: "unknown",
      productMatchConfidence: 0,
      error: { code: "PRODUCT_MISMATCH" },
    });
  });

  it("returns an explicit timeout error", async () => {
    const neverFetch: HttpFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const adapter = new ExampleJsonLdAdapter(neverFetch);
    await expect(
      adapter.checkInventory("https://example-retailer.test/item", { timeoutMs: 1 }),
    ).resolves.toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
  });
});

describe("checkInventory", () => {
  it("returns unsupported as unknown, never out of stock", async () => {
    await expect(
      checkInventory({ url: "https://unknown-shop.test/item" }, new AdapterRegistry()),
    ).resolves.toMatchObject({
      status: "unknown",
      error: { code: "UNSUPPORTED_RETAILER" },
    });
  });

  it("maps invalid URLs to a structured error", async () => {
    await expect(
      checkInventory({ url: "not a URL" }, new AdapterRegistry()),
    ).resolves.toMatchObject({ status: "error", error: { code: "INVALID_URL" } });
  });
});
