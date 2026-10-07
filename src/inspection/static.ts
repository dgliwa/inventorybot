import { createHash } from "node:crypto";
import { normalizeDomain } from "../adapters/url.js";
import {
  normalizeInventoryResult,
  type InventoryResult,
  type InventoryStatus,
} from "../domain/inventory.js";
import { matchProductIdentity, type ProductIdentity } from "../domain/product.js";
import type { RetailerInspection, InspectionObservation } from "./types.js";

type RawInspection = Omit<
  RetailerInspection,
  "adapterReadiness" | "identityVerified" | "nextAction"
>;
import { assertPublicHttpUrl, type HostResolver } from "./url-safety.js";

export type StaticFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" ? String(value) : undefined;
const normalizeText = (value: string): string =>
  value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");

function includesType(value: unknown, type: string): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some((candidate) => asString(candidate)?.split("/").pop() === type);
}

function findProducts(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(findProducts);
  if (!isObject(value)) return [];
  return [
    ...(includesType(value["@type"], "Product") ? [value] : []),
    ...Object.values(value).flatMap(findProducts),
  ];
}

function parseProducts(html: string): JsonObject[] {
  const products: JsonObject[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      products.push(...findProducts(JSON.parse(match[1].trim())));
    } catch {
      // A malformed block is an observation failure, not proof of stock state.
    }
  }
  return products;
}

function firstObject(value: unknown): JsonObject | undefined {
  if (Array.isArray(value)) return value.find(isObject);
  return isObject(value) ? value : undefined;
}

function identityFromProduct(product: JsonObject): ProductIdentity {
  const brand = product.brand;
  return {
    name: asString(product.name),
    manufacturer:
      asString(brand) ?? (isObject(brand) ? asString(brand.name) : undefined),
    sku: asString(product.sku),
    upc: asString(product.gtin ?? product.gtin12 ?? product.gtin13 ?? product.gtin14),
    mpn: asString(product.mpn),
  };
}

function statusFromAvailability(value: unknown): InventoryStatus {
  const token = asString(value)?.split("/").pop()?.toLocaleLowerCase();
  const statuses: Record<string, InventoryStatus> = {
    instock: "in_stock",
    onlineonly: "in_stock",
    outofstock: "out_of_stock",
    soldout: "out_of_stock",
    preorder: "preorder",
    presale: "preorder",
    backorder: "backorder",
    backordered: "backorder",
  };
  return token ? (statuses[token] ?? "unknown") : "unknown";
}

function baseResult(
  url: string,
  input: Omit<InventoryResult, "domain" | "url" | "checkedAt">,
): InventoryResult {
  return normalizeInventoryResult({ ...input, domain: normalizeDomain(url), url });
}

function blockedInspection(url: string, code: string, message: string): RawInspection {
  return {
    level: "static",
    finalUrl: url,
    inventory: baseResult(url, {
      status: "blocked",
      confidence: 1,
      method: "unknown",
      evidence: { summary: message },
      error: { code, message },
    }),
    observations: [{ source: "http", field: "blocked", value: message }],
    nextRecommendedLevel: "none",
  };
}

function jsonLdInspection(
  url: string,
  product: JsonObject,
  expectedProduct?: ProductIdentity,
): RawInspection {
  const identity = identityFromProduct(product);
  const match = expectedProduct ? matchProductIdentity(expectedProduct, identity) : undefined;
  if (match && !match.matches) {
    return {
      level: "static",
      finalUrl: url,
      product: identity,
      inventory: baseResult(url, {
        status: "unknown",
        confidence: 1,
        productMatchConfidence: match.confidence,
        method: "json_ld",
        evidence: { summary: "Structured product identifiers do not match the expected product." },
        error: { code: "PRODUCT_MISMATCH", message: "Product identity mismatch." },
      }),
      observations: [{ source: "json_ld", field: "product_match", value: false }],
      nextRecommendedLevel: "none",
    };
  }

  const offer = firstObject(product.offers);
  const availability = offer?.availability;
  const status = statusFromAvailability(availability);
  const priceValue = asString(offer?.price);
  const price = priceValue === undefined ? undefined : Number(priceValue);
  const observations: InspectionObservation[] = [
    { source: "json_ld", field: "product", value: true },
  ];
  if (availability !== undefined) {
    observations.push({ source: "json_ld", field: "availability", value: String(availability) });
  }
  const fixtureJson = JSON.stringify(product).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const fixtureHtml = `<script type="application/ld+json">${fixtureJson}</script>`;

  return {
    level: "static",
    finalUrl: url,
    product: identity,
    inventory: baseResult(url, {
      status,
      confidence: status === "unknown" ? 0 : 0.98,
      productMatchConfidence: match?.confidence,
      price: price !== undefined && Number.isFinite(price) ? price : undefined,
      currency: asString(offer?.priceCurrency),
      sku: identity.sku,
      seller:
        asString(offer?.seller) ??
        (isObject(offer?.seller) ? asString(offer.seller.name) : undefined),
      method: "json_ld",
      evidence: {
        summary:
          status === "unknown"
            ? "Product JSON-LD was found without recognized availability."
            : `schema.org availability maps to ${status}.`,
        raw: { availability, name: identity.name, sku: identity.sku },
      },
      ...(status === "unknown"
        ? { error: { code: "PARSE_ERROR", message: "Availability is missing or unsupported." } }
        : {}),
    }),
    observations,
    sanitizedFixture: {
      kind: "json_ld",
      html: fixtureHtml,
      sha256: createHash("sha256").update(fixtureHtml).digest("hex"),
    },
    nextRecommendedLevel: status === "unknown" ? "network" : "none",
  };
}

async function readPage(response: Response, maximumBytes = 2_000_000): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Retailer response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`Retailer response exceeds ${maximumBytes} bytes.`);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function htmlInspection(
  url: string,
  html: string,
  expectedProduct?: ProductIdentity,
): RawInspection {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const identity: ProductIdentity = { name: title };
  const exactIdentifiers = [expectedProduct?.sku, expectedProduct?.upc, expectedProduct?.mpn]
    .filter((value): value is string => Boolean(value));
  const identifiersPresent = exactIdentifiers.length === 0 || exactIdentifiers.some((identifier) =>
    normalizeText(html).includes(normalizeText(identifier)),
  );
  if (!identifiersPresent) {
    return {
      level: "static",
      finalUrl: url,
      product: identity,
      inventory: baseResult(url, {
        status: "unknown",
        confidence: 0,
        productMatchConfidence: 0,
        method: "html",
        evidence: { summary: "Expected product identifiers were not found in the page." },
        error: { code: "PRODUCT_MISMATCH", message: "Expected identifiers are absent." },
      }),
      observations: [{ source: "html", field: "product_match", value: false }],
      nextRecommendedLevel: "network",
    };
  }

  const outOfStock = /\b(out of stock|sold out|currently unavailable)\b/i.test(html);
  const inStock = /\b(in stock|available now)\b/i.test(html);
  const preorder = /\bpre[- ]?order\b/i.test(html);
  const backorder = /\bback[- ]?order(?:ed)?\b/i.test(html);
  const matches = [outOfStock, inStock, preorder, backorder].filter(Boolean).length;
  const status: InventoryStatus =
    matches !== 1
      ? "unknown"
      : outOfStock
        ? "out_of_stock"
        : inStock
          ? "in_stock"
          : preorder
            ? "preorder"
            : "backorder";

  return {
    level: "static",
    finalUrl: url,
    product: identity,
    inventory: baseResult(url, {
      status,
      confidence: status === "unknown" ? 0 : 0.7,
      productMatchConfidence: exactIdentifiers.length > 0 ? 0.7 : undefined,
      method: "html",
      evidence: {
        summary:
          status === "unknown"
            ? "Static HTML did not contain one unambiguous stock label."
            : `A static HTML stock label maps to ${status}.`,
        raw: { title },
      },
      ...(status === "unknown"
        ? { error: { code: "PARSE_ERROR", message: "Stock information is missing or ambiguous." } }
        : {}),
    }),
    observations: title ? [{ source: "html", field: "title", value: title }] : [],
    nextRecommendedLevel: status === "unknown" ? "network" : "none",
  };
}

function finalizeInspection(inspection: RawInspection): RetailerInspection {
  const errorCode = inspection.inventory.error?.code;
  const adapterReadiness = inspection.inventory.status === "blocked"
    ? "blocked"
    : errorCode === "PRODUCT_MISMATCH"
      ? "product_mismatch"
      : inspection.sanitizedFixture &&
          inspection.inventory.method === "json_ld" &&
          inspection.inventory.status !== "unknown" &&
          inspection.inventory.status !== "error"
        ? "ready_for_generation"
        : "insufficient_evidence";
  const identityVerified = inspection.inventory.productMatchConfidence !== undefined &&
    inspection.inventory.productMatchConfidence > 0;
  const nextActions = {
    ready_for_generation: "Generate and validate an inactive deterministic adapter candidate.",
    insufficient_evidence: inspection.nextRecommendedLevel === "network"
      ? "Use approved network or browser inspection; do not infer availability."
      : "Review the page evidence or try another direct product URL.",
    blocked: "Do not infer availability; try another retailer or approved inspection method.",
    product_mismatch: "Verify the product URL and expected UPC, SKU, or MPN.",
  } as const;
  return {
    ...inspection,
    adapterReadiness,
    identityVerified,
    nextAction: nextActions[adapterReadiness],
  };
}

export async function inspectRetailerStatic(
  url: string,
  options: {
    expectedProduct?: ProductIdentity;
    timeoutMs?: number;
    signal?: AbortSignal;
    httpFetch?: StaticFetch;
    resolveHost?: HostResolver;
  } = {},
): Promise<RetailerInspection> {
  const httpFetch = options.httpFetch ?? fetch;
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  let currentUrl = url;

  try {
    options.signal?.throwIfAborted();
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicHttpUrl(currentUrl, options.resolveHost);
      const response = await httpFetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "InventoryBot/0.1 read-only inventory inspection",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Too many or invalid HTTP redirects.");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if ([401, 403, 429].includes(response.status)) {
        return finalizeInspection(
          blockedInspection(currentUrl, "BLOCKED", `Retailer returned HTTP ${response.status}.`),
        );
      }
      if (!response.ok) {
        const code = response.status === 404 ? "PAGE_NOT_FOUND" : "HTTP_ERROR";
        return finalizeInspection({
          level: "static",
          finalUrl: currentUrl,
          inventory: baseResult(currentUrl, {
            status: "error",
            confidence: 1,
            method: "unknown",
            evidence: { summary: `Retailer returned HTTP ${response.status}.` },
            error: { code, message: `HTTP ${response.status}` },
          }),
          observations: [{ source: "http", field: "status", value: response.status }],
          nextRecommendedLevel: "none",
        });
      }

      const html = await readPage(response);
      if (/captcha|verify you are human|access denied|bot challenge/i.test(html)) {
        return finalizeInspection(
          blockedInspection(currentUrl, "CAPTCHA", "The page contains an anti-bot challenge."),
        );
      }
      const product = parseProducts(html)[0];
      return finalizeInspection(product
        ? jsonLdInspection(currentUrl, product, options.expectedProduct)
        : htmlInspection(currentUrl, html, options.expectedProduct));
    }
    throw new Error("Redirect handling failed.");
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const timedOut = controller.signal.aborted;
    let domain = "";
    try { domain = normalizeDomain(currentUrl); } catch { /* Invalid input has no domain. */ }
    const message = error instanceof Error ? error.message : String(error);
    const code = timedOut
      ? "TIMEOUT"
      : /exceeds \d+ bytes/i.test(message)
        ? "RESPONSE_TOO_LARGE"
        : error instanceof TypeError
          ? "INVALID_URL"
          : /local|private|allowed|credentials/i.test(message)
            ? "BLOCKED_URL"
            : "HTTP_ERROR";
    return finalizeInspection({
      level: "static",
      finalUrl: currentUrl,
      inventory: normalizeInventoryResult({
        status: code === "BLOCKED_URL" ? "blocked" : "error",
        confidence: 1,
        domain,
        url: currentUrl,
        method: "unknown",
        evidence: { summary: timedOut ? "Static inspection timed out." : "Static inspection failed." },
        error: { code, message },
      }),
      observations: [],
      nextRecommendedLevel: "none",
    });
  } finally {
    clearTimeout(timeout);
  }
}
