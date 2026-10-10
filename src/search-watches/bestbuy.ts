import type { SearchResult } from "../discovery/types.js";
import { assertPublicHttpUrl, type HostResolver } from "../inspection/url-safety.js";
import type { BestBuyHtmlSearchAdapter } from "./types.js";
import {
  decodeHtml,
  matchesQuery,
  readBounded,
  SearchAdapterDiscoveryError,
  textContent,
  type SearchFetch,
} from "./parsing.js";

const endpoint = "https://www.bestbuy.com/site/searchpage.jsp";
const maximumPages = 3;

export function createBestBuyAdapter(now: Date): BestBuyHtmlSearchAdapter {
  return {
    version: 1,
    kind: "bestbuy_html",
    domain: "bestbuy.com",
    searchUrl: endpoint,
    parser: "bestbuy_search_html",
    validatedAt: now.toISOString(),
    validationResultCount: 0,
  };
}

function canonicalProduct(rawUrl: string): string | undefined {
  try {
    const url = new URL(decodeHtml(rawUrl), "https://www.bestbuy.com");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["bestbuy.com", "www.bestbuy.com"].includes(url.hostname)
    ) return undefined;

    const current = url.pathname.match(/^\/product\/([a-z0-9-]+)\/([a-z0-9]{6,20})\/?$/i);
    if (current) return `https://www.bestbuy.com/product/${current[1]}/${current[2]}`;

    const legacy = url.pathname.match(/^\/site\/(?:[^/]+\/)?(\d{5,12})\.p$/i);
    const sku = legacy?.[1];
    if (sku && (!url.searchParams.get("skuId") || url.searchParams.get("skuId") === sku)) {
      return `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`;
    }
  } catch {
    // Ignore malformed and off-domain product links.
  }
  return undefined;
}

export function parseBestBuyResults(html: string, query: string): SearchResult[] {
  const unique = new Map<string, SearchResult>();
  const anchors = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchors)) {
    const url = canonicalProduct(match[2]);
    if (!url) continue;
    const title = textContent(match[3]);
    if (!title) continue;
    const result = { url, title };
    if (matchesQuery(result, query) && !unique.has(url)) unique.set(url, result);
  }
  return [...unique.values()];
}

export async function searchBestBuy(
  adapter: BestBuyHtmlSearchAdapter,
  query: string,
  count: number,
  fetchImpl: SearchFetch,
  resolver?: HostResolver,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (
    adapter.version !== 1 ||
    adapter.kind !== "bestbuy_html" ||
    adapter.parser !== "bestbuy_search_html" ||
    adapter.domain !== "bestbuy.com" ||
    adapter.searchUrl !== endpoint
  ) throw new Error("Invalid Best Buy search adapter configuration.");

  const limit = Math.min(50, Math.max(0, Math.floor(count)));
  if (!Number.isFinite(limit) || limit === 0) return [];
  const unique = new Map<string, SearchResult>();
  const timeout = AbortSignal.timeout(15_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  for (let page = 1; page <= maximumPages && unique.size < limit; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set("st", query);
    url.searchParams.set("cp", String(page));
    await assertPublicHttpUrl(url.toString(), resolver);
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "InventoryBot/0.1 deterministic-search-monitor",
      },
      signal: requestSignal,
    });
    if ([401, 403, 429, 435].includes(response.status)) {
      throw new SearchAdapterDiscoveryError(
        "SEARCH_SITE_BLOCKED",
        `Best Buy blocked search access with HTTP ${response.status}.`,
        "Do not bypass the challenge; retry only after normal public access is restored.",
      );
    }
    if (!response.ok) {
      throw new SearchAdapterDiscoveryError(
        "SEARCH_HTTP_ERROR",
        `Best Buy search returned HTTP ${response.status}.`,
        "Inspect the public search endpoint; redirects are not followed.",
      );
    }

    const body = await readBounded(response);
    if (/<title[^>]*>[^<]*(?:access\s*denied|captcha|verify\s+you\s+are\s+human)/i.test(body)) {
      throw new SearchAdapterDiscoveryError(
        "SEARCH_SITE_BLOCKED",
        "Best Buy returned an access challenge.",
        "Do not bypass the challenge; retry only after normal public access is restored.",
      );
    }

    const before = unique.size;
    const pageResults = parseBestBuyResults(body, query);
    for (const result of pageResults) {
      unique.set(result.url, result);
      if (unique.size >= limit) break;
    }
    if (unique.size === before || pageResults.length < 24) break;
  }

  return [...unique.values()].slice(0, limit);
}
