import { domainMatches, normalizeDomain } from "../adapters/url.js";
import { assertPublicHttpUrl } from "../inspection/url-safety.js";
export class SearchAdapterDiscoveryError extends Error {
    code;
    nextAction;
    constructor(code, message, nextAction) {
        super(message);
        this.code = code;
        this.nextAction = nextAction;
        this.name = "SearchAdapterDiscoveryError";
    }
}
function decodeHtml(value) {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}
function attributes(source) {
    const result = {};
    const pattern = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    for (const match of source.matchAll(pattern)) {
        result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
    }
    return result;
}
function textContent(value) {
    return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}
function clean(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function matchesQuery(result, query) {
    const tokens = clean(query).split(" ").filter((token) => token.length > 1);
    const haystack = clean(`${result.title ?? ""} ${result.snippet ?? ""} ${result.url}`);
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}
async function readBounded(response, maximumBytes = 5_000_000) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) {
        throw new SearchAdapterDiscoveryError("SEARCH_RESPONSE_TOO_LARGE", `Retailer response exceeds ${maximumBytes} bytes.`, "Use a narrower static search endpoint or add bounded API support.");
    }
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let body = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maximumBytes) {
            await reader.cancel();
            throw new SearchAdapterDiscoveryError("SEARCH_RESPONSE_TOO_LARGE", `Retailer response exceeds ${maximumBytes} bytes.`, "Use a narrower static search endpoint or add bounded API support.");
        }
        body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
}
function discoverForm(html, pageUrl, domain) {
    const candidates = [];
    for (const formMatch of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        const form = attributes(formMatch[1]);
        if ((form.method || "get").toLowerCase() !== "get")
            continue;
        const inputs = [...formMatch[2].matchAll(/<input\b([^>]*)>/gi)].map((match) => attributes(match[1]));
        const queryInput = inputs
            .map((input) => {
            const name = input.name?.trim();
            if (!name || input.disabled !== undefined)
                return undefined;
            const type = (input.type || "text").toLowerCase();
            const semantic = `${name} ${input.id ?? ""} ${input.placeholder ?? ""} ${input["aria-label"] ?? ""}`.toLowerCase();
            const score = (type === "search" ? 10 : 0) + (/\b(q|query|search|keyword|keywords|term)\b/.test(semantic) ? 6 : 0);
            return score > 0 ? { name, score } : undefined;
        })
            .filter((value) => Boolean(value))
            .sort((left, right) => right.score - left.score)[0];
        if (!queryInput)
            continue;
        const searchUrl = new URL(form.action || pageUrl, pageUrl);
        if (!domainMatches(normalizeDomain(searchUrl.toString()), domain))
            continue;
        searchUrl.hash = "";
        const fixedParameters = {};
        for (const input of inputs) {
            if (input.name && input.name !== queryInput.name && (input.type || "").toLowerCase() === "hidden" && input.value) {
                fixedParameters[input.name] = input.value;
            }
        }
        candidates.push({
            searchUrl: searchUrl.toString(),
            queryParameter: queryInput.name,
            fixedParameters,
            score: queryInput.score + (/search/i.test(form.role ?? "") ? 4 : 0),
        });
    }
    return candidates.sort((left, right) => right.score - left.score)[0];
}
function productJsonLdResults(html, pageUrl, domain) {
    const results = [];
    const visit = (value) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== "object")
            return;
        const object = value;
        const type = String(object["@type"] ?? "").split("/").pop();
        if (type === "Product" || type === "ListItem") {
            const item = object.item && typeof object.item === "object"
                ? object.item
                : object;
            const rawUrl = item.url ?? object.url;
            if (typeof rawUrl === "string") {
                try {
                    const url = new URL(rawUrl, pageUrl);
                    if (domainMatches(normalizeDomain(url.toString()), domain)) {
                        results.push({
                            url: url.toString(),
                            ...(typeof item.name === "string" ? { title: item.name } : {}),
                            ...(typeof item.description === "string" ? { snippet: textContent(item.description) } : {}),
                        });
                    }
                }
                catch {
                    // Ignore malformed retailer data.
                }
            }
        }
        Object.values(object).forEach(visit);
    };
    for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            visit(JSON.parse(match[1].trim()));
        }
        catch {
            // Ignore malformed blocks when other deterministic evidence is available.
        }
    }
    return results;
}
function anchorResults(html, pageUrl, domain) {
    const results = [];
    for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const attrs = attributes(match[1]);
        if (!attrs.href || /^(#|javascript:|mailto:|tel:)/i.test(attrs.href))
            continue;
        try {
            const url = new URL(attrs.href, pageUrl);
            if (!domainMatches(normalizeDomain(url.toString()), domain))
                continue;
            const title = textContent(match[2]) || attrs.title || attrs["aria-label"];
            if (!title)
                continue;
            results.push({ url: url.toString(), title });
        }
        catch {
            // Ignore malformed links.
        }
    }
    return results;
}
function parseResults(html, pageUrl, domain, query, count) {
    const unique = new Map();
    for (const result of [...productJsonLdResults(html, pageUrl, domain), ...anchorResults(html, pageUrl, domain)]) {
        if (!matchesQuery(result, query))
            continue;
        try {
            const url = new URL(result.url);
            url.hash = "";
            if (url.toString() === pageUrl)
                continue;
            unique.set(url.toString(), { ...result, url: url.toString() });
        }
        catch {
            // Ignore malformed links.
        }
        if (unique.size >= count)
            break;
    }
    return [...unique.values()];
}
export class DirectRetailerSearchClient {
    fetchImpl;
    resolver;
    now;
    constructor(fetchImpl = fetch, resolver, now = () => new Date()) {
        this.fetchImpl = fetchImpl;
        this.resolver = resolver;
        this.now = now;
    }
    async discover(domain, query, signal) {
        const normalizedDomain = normalizeDomain(domain.includes("://") ? domain : `https://${domain}`);
        const homepage = await assertPublicHttpUrl(`https://${normalizedDomain}/`, this.resolver);
        const homepageResponse = await this.fetchPage(homepage.toString(), signal);
        const form = discoverForm(homepageResponse.html, homepageResponse.url, normalizedDomain);
        if (!form) {
            if (normalizedDomain === "costco.com" || normalizedDomain === "www.costco.com") {
                return this.discoverCostcoGrs(homepageResponse.html, normalizedDomain, query, signal);
            }
            throw new SearchAdapterDiscoveryError("SEARCH_FORM_NOT_FOUND", `No deterministic GET search form was found on ${normalizedDomain}.`, "The retailer may require JavaScript, authentication, a POST request, or a retailer-specific search adapter.");
        }
        const provisional = {
            version: 1,
            kind: "html_get",
            domain: normalizedDomain,
            searchUrl: form.searchUrl,
            queryParameter: form.queryParameter,
            fixedParameters: form.fixedParameters,
            parser: "html_links",
            validatedAt: this.now().toISOString(),
            validationResultCount: 0,
        };
        const first = await this.search(provisional, query, 50, signal);
        if (first.length === 0) {
            throw new SearchAdapterDiscoveryError("SEARCH_RESULTS_NOT_PARSEABLE", `The discovered search endpoint returned no reliably matching product links for “${query}”.`, "Verify that the retailer has matching products or add a retailer-specific parser for its result markup.");
        }
        const second = await this.search(provisional, query, 50, signal);
        const repeated = new Set(second.map((result) => result.url));
        if (!first.some((result) => repeated.has(result.url))) {
            throw new SearchAdapterDiscoveryError("SEARCH_ADAPTER_VALIDATION_FAILED", "Repeated live searches did not return any stable matching product URL.", "Retry later or inspect the retailer for dynamic, personalized, or blocked search results.");
        }
        return {
            adapter: { ...provisional, validationResultCount: first.length },
            results: first,
        };
    }
    async search(adapter, query, count, signal) {
        if (adapter.version !== 1) {
            throw new Error("Unsupported deterministic search adapter version.");
        }
        if (adapter.kind === "costco_grs") {
            return this.searchCostcoGrs(adapter, query, count, signal);
        }
        if (adapter.kind !== "html_get" || adapter.parser !== "html_links") {
            throw new Error("Unsupported deterministic search adapter kind or parser.");
        }
        const url = new URL(adapter.searchUrl);
        for (const [key, value] of Object.entries(adapter.fixedParameters))
            url.searchParams.set(key, value);
        url.searchParams.set(adapter.queryParameter, query);
        const page = await this.fetchPage(url.toString(), signal);
        if (!domainMatches(normalizeDomain(page.url), adapter.domain)) {
            throw new SearchAdapterDiscoveryError("SEARCH_REDIRECTED_OFF_DOMAIN", `Retailer search redirected outside ${adapter.domain}.`, "Inspect the retailer's current search endpoint before enabling this watch.");
        }
        return parseResults(page.html, page.url, adapter.domain, query, count);
    }
    async discoverCostcoGrs(homepageHtml, domain, query, signal) {
        const endpoint = "https://gdx-api.costco.com/catalog/search/api/v1/search?searchType=page";
        if (!homepageHtml.includes(endpoint.split("?")[0])) {
            throw new SearchAdapterDiscoveryError("SEARCH_RETAILER_API_NOT_FOUND", "Costco's public catalog search configuration was not present on its homepage.", "Retry after Costco's site is available or update the retailer-specific adapter detector.");
        }
        const endpointIndex = homepageHtml.indexOf(endpoint.split("?")[0]);
        const configuration = homepageHtml.slice(endpointIndex, endpointIndex + 2_000);
        const clientIdentifier = configuration.match(/client-identifier\\?"\s*:\s*\\?"([0-9a-f-]{36})/i)?.[1];
        const warehouseId = homepageHtml.match(/warehouseNumber\\?"\s*:\s*\\?"(\d+)/i)?.[1];
        if (!clientIdentifier || !warehouseId) {
            throw new SearchAdapterDiscoveryError("SEARCH_RETAILER_API_CONFIG_INVALID", "Costco's public search configuration was incomplete.", "Inspect Costco's current catalog application configuration before registering the watch.");
        }
        const provisional = {
            version: 1,
            kind: "costco_grs",
            domain: "costco.com",
            searchUrl: endpoint,
            clientIdentifier,
            clientId: "USBC",
            locale: "en-US",
            warehouseId,
            parser: "costco_grs_v1",
            validatedAt: this.now().toISOString(),
            validationResultCount: 0,
        };
        const first = await this.searchCostcoGrs(provisional, query, 50, signal);
        if (first.length === 0) {
            throw new SearchAdapterDiscoveryError("SEARCH_RESULTS_NOT_PARSEABLE", `Costco's catalog API returned no matching products for “${query}”.`, "Verify Costco currently has matching catalog products before registering the watch.");
        }
        const second = await this.searchCostcoGrs(provisional, query, 50, signal);
        const repeated = new Set(second.map((result) => result.url));
        if (!first.some((result) => repeated.has(result.url))) {
            throw new SearchAdapterDiscoveryError("SEARCH_ADAPTER_VALIDATION_FAILED", "Repeated Costco catalog searches did not return a stable product URL.", "Retry later; the retailer API may be unstable or returning personalized results.");
        }
        return {
            adapter: { ...provisional, validationResultCount: first.length },
            results: first,
        };
    }
    async searchCostcoGrs(adapter, query, count, signal) {
        await assertPublicHttpUrl(adapter.searchUrl, this.resolver);
        const timeoutSignal = AbortSignal.timeout(15_000);
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const response = await this.fetchImpl(adapter.searchUrl, {
            method: "POST",
            redirect: "manual",
            signal: requestSignal,
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                "client-identifier": adapter.clientIdentifier,
                client_id: adapter.clientId,
                locale: adapter.locale,
                searchResultProvider: "GRS",
                origin: "https://www.costco.com",
                referer: `https://www.costco.com/s?keyword=${encodeURIComponent(query)}`,
                "user-agent": "InventoryBot/0.1 deterministic-search-monitor",
            },
            body: JSON.stringify({
                deliveryLocations: [],
                filterBy: [],
                offset: 0,
                pageSize: Math.min(count, 50),
                personalizationEnabled: false,
                query,
                searchMode: "page",
                visitorId: crypto.randomUUID(),
                warehouseId: adapter.warehouseId,
                shipToState: "",
                shipToPostal: "",
                pageCategories: [],
            }),
        });
        if (response.status >= 300 && response.status < 400) {
            throw new SearchAdapterDiscoveryError("SEARCH_RETAILER_API_REDIRECTED", `Costco's catalog API redirected with HTTP ${response.status}.`, "Reinspect Costco's current public catalog endpoint.");
        }
        if (!response.ok) {
            throw new SearchAdapterDiscoveryError(response.status === 401 || response.status === 403 ? "SEARCH_SITE_BLOCKED" : "SEARCH_HTTP_ERROR", `Costco's catalog API returned HTTP ${response.status}.`, "Reinspect Costco's public application configuration; do not bypass authentication or access controls.");
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > 5_000_000) {
            throw new SearchAdapterDiscoveryError("SEARCH_RESPONSE_TOO_LARGE", "Costco's catalog API response exceeded 5000000 bytes.", "Use a smaller bounded result page.");
        }
        const payload = await response.json();
        const unique = new Map();
        for (const item of payload.searchResult?.results ?? []) {
            const title = item.product?.title?.trim();
            const rawUrl = item.product?.uri;
            if (!title || !rawUrl)
                continue;
            try {
                const url = new URL(rawUrl);
                if (!domainMatches(normalizeDomain(url.toString()), adapter.domain))
                    continue;
                const result = { url: url.toString(), title };
                if (!matchesQuery(result, query))
                    continue;
                unique.set(result.url, result);
            }
            catch {
                // Ignore malformed retailer results.
            }
            if (unique.size >= count)
                break;
        }
        return [...unique.values()];
    }
    async fetchPage(url, signal) {
        const timeoutSignal = AbortSignal.timeout(15_000);
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let currentUrl = url;
        let response;
        for (let redirect = 0; redirect <= 5; redirect += 1) {
            await assertPublicHttpUrl(currentUrl, this.resolver);
            response = await this.fetchImpl(currentUrl, {
                method: "GET",
                redirect: "manual",
                signal: requestSignal,
                headers: {
                    accept: "text/html,application/xhtml+xml",
                    "user-agent": "InventoryBot/0.1 deterministic-search-monitor",
                },
            });
            if (![301, 302, 303, 307, 308].includes(response.status))
                break;
            const location = response.headers.get("location");
            if (!location)
                break;
            currentUrl = new URL(location, currentUrl).toString();
            response = undefined;
        }
        if (!response) {
            throw new SearchAdapterDiscoveryError("SEARCH_TOO_MANY_REDIRECTS", "Retailer search exceeded five redirects.", "Inspect the retailer's current canonical search endpoint.");
        }
        await assertPublicHttpUrl(response.url || currentUrl, this.resolver);
        if (response.status === 403 || response.status === 429) {
            throw new SearchAdapterDiscoveryError("SEARCH_SITE_BLOCKED", `Retailer search was blocked with HTTP ${response.status}.`, "Do not bypass the challenge; use a supported retailer API or retry after the block clears.");
        }
        if (!response.ok) {
            throw new SearchAdapterDiscoveryError("SEARCH_HTTP_ERROR", `Retailer search returned HTTP ${response.status}.`, "Verify the retailer is reachable and its search endpoint still exists.");
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
            throw new SearchAdapterDiscoveryError("SEARCH_CONTENT_TYPE_UNSUPPORTED", `Retailer returned unsupported content type ${contentType}.`, "Add a retailer-specific API parser before registering this search monitor.");
        }
        const html = await readBounded(response);
        const title = textContent(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
        const challengePage = /captcha|verify you are human|access denied/i.test(title) ||
            (html.length < 200_000 && /verify you are human|access denied/i.test(html));
        if (challengePage) {
            throw new SearchAdapterDiscoveryError("SEARCH_SITE_BLOCKED", "Retailer returned an access challenge page.", "Do not bypass the challenge; add an approved retailer-specific integration instead.");
        }
        return { url: response.url || currentUrl, html };
    }
}
