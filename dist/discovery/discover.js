import { normalizeDomain } from "../adapters/url.js";
const MARKETPLACES = new Set([
    "amazon.com",
    "ebay.com",
    "etsy.com",
    "walmart.com",
    "aliexpress.com",
]);
const REJECTED_DOMAINS = [
    "facebook.com",
    "instagram.com",
    "pinterest.com",
    "reddit.com",
    "tiktok.com",
    "youtube.com",
];
const REJECTED_PATH_PARTS = [
    "/blog/",
    "/blogs/",
    "/category/",
    "/collections/",
    "/forum/",
    "/news/",
    "/search",
    "/support/",
];
const normalizeText = (value) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
function buildQueries(product) {
    const prefix = product.manufacturer ? `"${product.manufacturer}" ` : "";
    const queries = [];
    for (const field of ["sku", "upc", "mpn"]) {
        const value = product[field]?.trim();
        if (value) {
            queries.push({
                query: `${prefix}"${value}" buy`,
                matchedBy: field,
                needle: value,
            });
        }
    }
    if (queries.length === 0 && product.name?.trim()) {
        const variant = product.variant ? ` "${product.variant}"` : "";
        queries.push({
            query: `${prefix}"${product.name.trim()}"${variant} buy`,
            matchedBy: "name",
            needle: product.name,
        });
    }
    return queries;
}
function canonicalProductUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
            if (/^(utm_|gclid$|fbclid$|ref$|source$)/i.test(key)) {
                url.searchParams.delete(key);
            }
        }
        url.searchParams.sort();
        url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
        return url.toString();
    }
    catch {
        return undefined;
    }
}
function isLikelyProductPage(result, canonicalUrl) {
    const parsed = new URL(canonicalUrl);
    const domain = normalizeDomain(canonicalUrl);
    if (REJECTED_DOMAINS.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) {
        return false;
    }
    const path = parsed.pathname.toLocaleLowerCase();
    if (path === "/" || REJECTED_PATH_PARTS.some((part) => path.includes(part))) {
        return false;
    }
    const text = `${result.title ?? ""} ${result.snippet ?? ""}`;
    return !/review|manual|used price guide|coupon/i.test(text);
}
function classifySeller(domain, product) {
    if ([...MARKETPLACES].some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) {
        return "marketplace";
    }
    const manufacturer = product.manufacturer && normalizeText(product.manufacturer);
    if (manufacturer && manufacturer.length >= 3 && normalizeText(domain).includes(manufacturer)) {
        return "manufacturer";
    }
    return "unknown";
}
function candidateFromResult(result, query, product) {
    const url = canonicalProductUrl(result.url);
    if (!url || !isLikelyProductPage(result, url)) {
        return undefined;
    }
    const domain = normalizeDomain(url);
    const searchText = normalizeText(`${result.title ?? ""} ${result.snippet ?? ""} ${url}`);
    const identifierMatched = searchText.includes(normalizeText(query.needle));
    const confidence = Math.min(0.95, (query.matchedBy === "name" ? 0.5 : 0.65) + (identifierMatched ? 0.25 : 0));
    return {
        domain,
        url,
        confidence,
        matchedBy: query.matchedBy,
        sellerType: classifySeller(domain, product),
    };
}
export async function discoverRetailers(product, searchClient, options = {}) {
    const queries = buildQueries(product);
    const candidates = new Map();
    const errors = [];
    if (product.sourceUrl) {
        const url = canonicalProductUrl(product.sourceUrl);
        if (url) {
            candidates.set(url, {
                domain: normalizeDomain(url),
                url,
                confidence: 1,
                matchedBy: "source_url",
                sellerType: classifySeller(normalizeDomain(url), product),
            });
        }
        else {
            errors.push({
                query: "sourceUrl",
                code: "INVALID_URL",
                message: "The product sourceUrl is not a valid HTTP(S) URL.",
            });
        }
    }
    if (queries.length === 0 && !product.sourceUrl) {
        errors.push({
            query: "",
            code: "PRODUCT_IDENTITY_INSUFFICIENT",
            message: "Provide an exact identifier, product name, or source URL.",
        });
    }
    for (const query of queries) {
        try {
            const results = await searchClient.search(query.query, options.resultsPerQuery ?? 8, options.signal);
            for (const result of results) {
                const candidate = candidateFromResult(result, query, product);
                if (!candidate)
                    continue;
                const previous = candidates.get(candidate.url);
                if (!previous || candidate.confidence > previous.confidence) {
                    candidates.set(candidate.url, candidate);
                }
            }
        }
        catch (error) {
            errors.push({
                query: query.query,
                code: "DISCOVERY_SEARCH_FAILED",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return {
        product,
        queries: queries.map(({ query }) => query),
        candidates: [...candidates.values()].sort((left, right) => right.confidence - left.confidence),
        errors,
    };
}
