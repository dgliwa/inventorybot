import type { SearchResult } from "../discovery/types.js";
import { type HostResolver } from "../inspection/url-safety.js";
import type { BestBuyHtmlSearchAdapter } from "./types.js";
import { type SearchFetch } from "./parsing.js";
export declare function createBestBuyAdapter(now: Date): BestBuyHtmlSearchAdapter;
export declare function parseBestBuyResults(html: string, query: string): SearchResult[];
export declare function searchBestBuy(adapter: BestBuyHtmlSearchAdapter, query: string, count: number, fetchImpl: SearchFetch, resolver?: HostResolver, signal?: AbortSignal): Promise<SearchResult[]>;
