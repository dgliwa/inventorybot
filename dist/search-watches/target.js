import { assertPublicHttpUrl } from "../inspection/url-safety.js";
import { matchesQuery, readBounded, SearchAdapterDiscoveryError, textContent } from "./parsing.js";
const endpoint = "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2";
export function discoverTargetConfig(html, now) {
    let apiKey;
    let pricingStoreId;
    // Decode embedded JSON only; never evaluate storefront JavaScript.
    for (const match of html.matchAll(/JSON\.parse\(("(?:\\.|[^"\\])*")\)/g)) {
        try {
            const config = JSON.parse(JSON.parse(match[1]));
            const service = config?.services?.redskyAggregations;
            if (service?.baseUrl === "https://redsky.target.com" &&
                new URL(service.apis.product.endpointPaths.plpSearchV2, service.baseUrl).toString() === endpoint &&
                typeof service.apiKey === "string" && /^[a-z0-9]{20,80}$/i.test(service.apiKey)) {
                apiKey = service.apiKey;
            }
            const storeId = config?.serverLocationVariables?.store_id;
            if (typeof storeId === "string" && /^\d{1,8}$/.test(storeId))
                pricingStoreId = storeId;
        }
        catch { /* Ignore unrelated or malformed configuration. */ }
    }
    if (apiKey && pricingStoreId) {
        return { version: 1, kind: "target_redsky", domain: "target.com", searchUrl: endpoint,
            apiKey, pricingStoreId, parser: "target_redsky_v2", validatedAt: now.toISOString(), validationResultCount: 0 };
    }
    throw new SearchAdapterDiscoveryError("SEARCH_RETAILER_API_CONFIG_INVALID", "Target's public catalog configuration was absent or changed.", "Inspect the public storefront configuration; do not supply private credentials.");
}
export async function searchTarget(adapter, query, count, fetchImpl, resolver, signal) {
    // Exact allowlist also protects adapters loaded from storage. Never follow API redirects.
    if (adapter.parser !== "target_redsky_v2" || adapter.domain !== "target.com" || adapter.searchUrl !== endpoint ||
        !/^\d{1,8}$/.test(adapter.pricingStoreId)) {
        throw new Error("Unsupported Target search configuration.");
    }
    const limit = Math.min(50, Math.max(0, Math.floor(count)));
    if (!Number.isFinite(limit) || limit === 0)
        return [];
    const unique = new Map();
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    // Three 24-product pages maximum (72 candidates), not an unbounded catalog crawl.
    for (let offset = 0; offset < 72 && unique.size < limit; offset += 24) {
        const url = new URL(endpoint);
        url.search = new URLSearchParams({ key: adapter.apiKey, keyword: query, count: "24",
            offset: String(offset), channel: "WEB", page: "/s/" + query,
            pricing_store_id: adapter.pricingStoreId, visitor_id: "0000000000000000000000000000000000" }).toString();
        await assertPublicHttpUrl(url.toString(), resolver);
        const response = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", signal: requestSignal,
            headers: { accept: "application/json", "user-agent": "InventoryBot/0.1 deterministic-search-monitor" } });
        if ([401, 403, 429, 435].includes(response.status))
            throw new SearchAdapterDiscoveryError("SEARCH_SITE_BLOCKED", "Target's catalog API blocked access with HTTP " + response.status + ".", "Do not bypass the challenge; retry only after access is restored.");
        if (!response.ok)
            throw new SearchAdapterDiscoveryError("SEARCH_HTTP_ERROR", "Target's catalog API returned HTTP " + response.status + ".", "Inspect the public endpoint; redirects are not followed.");
        const body = await readBounded(response);
        if (/<title[^>]*>[^<]*(?:access.*denied|captcha|verify)/i.test(body))
            throw new SearchAdapterDiscoveryError("SEARCH_SITE_BLOCKED", "Target returned an access challenge.", "Do not bypass the challenge.");
        let payload;
        try {
            payload = JSON.parse(body);
        }
        catch {
            throw new SearchAdapterDiscoveryError("SEARCH_RESULTS_NOT_PARSEABLE", "Target did not return catalog JSON.", "Inspect the public endpoint.");
        }
        const search = payload?.data?.search;
        if (!Array.isArray(search?.products))
            throw new SearchAdapterDiscoveryError("SEARCH_RESULTS_NOT_PARSEABLE", "Target's catalog response schema changed.", "Update the Target parser before enabling this watch.");
        for (const product of search.products) {
            const title = product?.item?.product_description?.title;
            const rawUrl = product?.item?.enrichment?.buy_url;
            if (typeof title !== "string" || typeof rawUrl !== "string")
                continue;
            try {
                const productUrl = new URL(rawUrl, "https://www.target.com");
                const id = productUrl.pathname.match(/\/-\/A-(\d+)$/)?.[1];
                if (productUrl.protocol !== "https:" || productUrl.username || productUrl.password || productUrl.port ||
                    !["target.com", "www.target.com"].includes(productUrl.hostname) || !id)
                    continue;
                const result = { title: textContent(title), url: "https://www.target.com/p/-/A-" + id };
                if (matchesQuery(result, query))
                    unique.set(result.url, result);
            }
            catch { /* Ignore malformed/off-domain product URLs. */ }
            if (unique.size >= limit)
                break;
        }
        const total = Number(search.search_response?.metadata?.total_results);
        if (search.products.length < 24 || (Number.isFinite(total) && total >= 0 && offset + 24 >= total))
            break;
    }
    return [...unique.values()];
}
