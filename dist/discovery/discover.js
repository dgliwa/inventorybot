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
function buildQueries(product, preferredDomains) {
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
    const name = product.name?.trim();
    if (name) {
        const variant = product.variant ? ` "${product.variant}"` : "";
        queries.push({
            query: `${prefix}"${name}"${variant} buy`,
            matchedBy: "name",
            needle: name,
        });
    }
    const preferredNeedle = name ?? product.upc?.trim() ?? product.sku?.trim() ?? product.mpn?.trim();
    const preferredMatch = name
        ? "name"
        : product.upc?.trim()
            ? "upc"
            : product.sku?.trim()
                ? "sku"
                : "mpn";
    if (preferredNeedle) {
        for (const domain of preferredDomains) {
            queries.push({
                query: `site:${domain} "${preferredNeedle}"`,
                matchedBy: preferredMatch,
                needle: preferredNeedle,
                preferredDomain: domain,
            });
        }
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
function candidateFromResult(result, query, product, preferredDomains) {
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
        preferred: preferredDomains.some((preferred) => domain === preferred || domain.endsWith(`.${preferred}`)),
    };
}
export async function discoverRetailers(product, searchClient, options = {}) {
    const errors = [];
    const preferredDomains = [...new Set((options.preferredDomains ?? []).flatMap((value) => {
            try {
                return [normalizeDomain(value.includes("://") ? value : `https://${value}`)];
            }
            catch {
                errors.push({
                    query: value,
                    code: "INVALID_PREFERRED_DOMAIN",
                    message: `Preferred retailer domain ${value} is invalid.`,
                    nextAction: "Provide a hostname such as target.com, without a path.",
                });
                return [];
            }
        }))];
    const queries = buildQueries(product, preferredDomains);
    const candidates = new Map();
    if (product.sourceUrl) {
        const url = canonicalProductUrl(product.sourceUrl);
        if (url) {
            candidates.set(url, {
                domain: normalizeDomain(url),
                url,
                confidence: 1,
                matchedBy: "source_url",
                sellerType: classifySeller(normalizeDomain(url), product),
                preferred: preferredDomains.some((preferred) => normalizeDomain(url) === preferred || normalizeDomain(url).endsWith(`.${preferred}`)),
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
                const candidate = candidateFromResult(result, query, product, preferredDomains);
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
                nextAction: "Test the configured OpenClaw web-search provider, then retry discovery.",
            });
        }
    }
    return {
        product,
        queries: queries.map(({ query }) => query),
        candidates: [...candidates.values()].sort((left, right) => Number(right.preferred) - Number(left.preferred) || right.confidence - left.confidence),
        errors,
        inventoryVerified: false,
    };
}
