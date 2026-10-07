import { normalizeInventoryResult, } from "../../domain/inventory.js";
import { matchProductIdentity, } from "../../domain/product.js";
import { domainMatches, normalizeDomain } from "../url.js";
const AVAILABILITY = {
    instock: "in_stock",
    onlineonly: "in_stock",
    outofstock: "out_of_stock",
    soldout: "out_of_stock",
    preorder: "preorder",
    presale: "preorder",
    backorder: "backorder",
    backordered: "backorder",
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value) => typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
function typeIncludes(value, expected) {
    return Array.isArray(value)
        ? value.includes(expected)
        : value === expected || value === `https://schema.org/${expected}`;
}
function findProducts(value) {
    if (Array.isArray(value)) {
        return value.flatMap(findProducts);
    }
    if (!isObject(value)) {
        return [];
    }
    const matches = typeIncludes(value["@type"], "Product") ? [value] : [];
    return [
        ...matches,
        ...Object.values(value).flatMap((nested) => findProducts(nested)),
    ];
}
function parseJsonLd(html) {
    const scripts = html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    const products = [];
    for (const match of scripts) {
        try {
            products.push(...findProducts(JSON.parse(match[1].trim())));
        }
        catch {
            // Ignore malformed blocks; another valid JSON-LD block may exist.
        }
    }
    return products;
}
function firstOffer(product) {
    const offers = product.offers;
    if (Array.isArray(offers)) {
        return offers.find(isObject);
    }
    return isObject(offers) ? offers : undefined;
}
function productIdentity(product) {
    const brand = product.brand;
    return {
        name: stringValue(product.name),
        sku: stringValue(product.sku),
        upc: stringValue(product.gtin ?? product.gtin12 ?? product.gtin13),
        mpn: stringValue(product.mpn),
        manufacturer: stringValue(brand) ?? (isObject(brand) ? stringValue(brand.name) : undefined),
    };
}
function availabilityStatus(value) {
    const availability = stringValue(value)?.split("/").pop()?.toLocaleLowerCase();
    return availability ? (AVAILABILITY[availability] ?? "unknown") : "unknown";
}
function blockedResult(url, code, message) {
    return normalizeInventoryResult({
        status: "blocked",
        confidence: 1,
        domain: normalizeDomain(url),
        url,
        method: "unknown",
        evidence: { summary: message },
        error: { code, message },
    });
}
export class ExampleJsonLdAdapter {
    httpFetch;
    id = "example-retailer-jsonld";
    version = "1.0.0";
    domains = ["example-retailer.test"];
    constructor(httpFetch = fetch) {
        this.httpFetch = httpFetch;
    }
    canHandle(url) {
        try {
            const domain = normalizeDomain(url);
            return this.domains.some((candidate) => domainMatches(domain, candidate));
        }
        catch {
            return false;
        }
    }
    async checkInventory(url, context = {}) {
        const timeoutMs = context.timeoutMs ?? 10_000;
        const controller = new AbortController();
        const signal = context.signal
            ? AbortSignal.any([controller.signal, context.signal])
            : controller.signal;
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            context.signal?.throwIfAborted();
            const response = await this.httpFetch(url, {
                method: "GET",
                redirect: "follow",
                signal,
                headers: { Accept: "text/html,application/xhtml+xml" },
            });
            if (response.status === 401 || response.status === 403 || response.status === 429) {
                return blockedResult(url, "BLOCKED", `Retailer returned HTTP ${response.status}.`);
            }
            if (!response.ok) {
                return normalizeInventoryResult({
                    status: "error",
                    confidence: 1,
                    domain: normalizeDomain(url),
                    url,
                    method: "unknown",
                    evidence: { summary: `Retailer returned HTTP ${response.status}.` },
                    error: { code: response.status === 404 ? "PAGE_NOT_FOUND" : "HTTP_ERROR", message: `HTTP ${response.status}` },
                });
            }
            const html = await response.text();
            if (/captcha|verify you are human|access denied|bot challenge/i.test(html)) {
                return blockedResult(url, "CAPTCHA", "The page contains an anti-bot challenge.");
            }
            const product = parseJsonLd(html)[0];
            if (!product) {
                return normalizeInventoryResult({
                    status: "unknown",
                    confidence: 0,
                    domain: normalizeDomain(url),
                    url,
                    method: "json_ld",
                    evidence: { summary: "No valid schema.org Product JSON-LD was found." },
                    error: { code: "PARSE_ERROR", message: "Product JSON-LD missing or malformed." },
                });
            }
            const actualProduct = productIdentity(product);
            const match = context.expectedProduct
                ? matchProductIdentity(context.expectedProduct, actualProduct)
                : undefined;
            if (match && !match.matches) {
                return normalizeInventoryResult({
                    status: "unknown",
                    confidence: 1,
                    domain: normalizeDomain(url),
                    url,
                    productMatchConfidence: match.confidence,
                    method: "json_ld",
                    evidence: { summary: "The page identifiers do not match the expected product." },
                    error: { code: "PRODUCT_MISMATCH", message: "Product identity mismatch." },
                });
            }
            const offer = firstOffer(product);
            const status = availabilityStatus(offer?.availability);
            const priceText = stringValue(offer?.price);
            const price = priceText === undefined ? undefined : Number(priceText);
            const sellerValue = offer?.seller;
            const seller = stringValue(sellerValue) ??
                (isObject(sellerValue) ? stringValue(sellerValue.name) : undefined);
            return normalizeInventoryResult({
                status,
                confidence: status === "unknown" ? 0 : 0.98,
                domain: normalizeDomain(url),
                url,
                productMatchConfidence: match?.confidence,
                price: price !== undefined && Number.isFinite(price) ? price : undefined,
                currency: stringValue(offer?.priceCurrency),
                sku: actualProduct.sku,
                seller,
                method: "json_ld",
                evidence: {
                    summary: status === "unknown"
                        ? "Product JSON-LD was found, but availability was missing or unsupported."
                        : `schema.org availability maps to ${status}.`,
                    raw: {
                        availability: offer?.availability,
                        name: actualProduct.name,
                        sku: actualProduct.sku,
                    },
                },
                ...(status === "unknown"
                    ? { error: { code: "PARSE_ERROR", message: "Availability is not recognized." } }
                    : {}),
            });
        }
        catch (error) {
            if (context.signal?.aborted)
                throw error;
            const timedOut = controller.signal.aborted;
            return normalizeInventoryResult({
                status: "error",
                confidence: 1,
                domain: normalizeDomain(url),
                url,
                method: "unknown",
                evidence: { summary: timedOut ? "Inventory request timed out." : "Inventory request failed." },
                error: {
                    code: timedOut ? "TIMEOUT" : "HTTP_ERROR",
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
        finally {
            clearTimeout(timeout);
        }
    }
}
