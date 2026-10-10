import type { SearchResult } from "../discovery/types.js";
import { type HostResolver } from "../inspection/url-safety.js";
import type { DeterministicSearchAdapter, DeterministicSearchClient } from "./types.js";
import { type SearchFetch } from "./parsing.js";
export { SearchAdapterDiscoveryError, type SearchFetch } from "./parsing.js";
export declare class DirectRetailerSearchClient implements DeterministicSearchClient {
    private readonly fetchImpl;
    private readonly resolver?;
    private readonly now;
    constructor(fetchImpl?: SearchFetch, resolver?: HostResolver | undefined, now?: () => Date);
    discover(domain: string, query: string, signal?: AbortSignal): Promise<{
        adapter: DeterministicSearchAdapter;
        results: SearchResult[];
    }>;
    search(adapter: DeterministicSearchAdapter, query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]>;
    private discoverCostcoGrs;
    private searchCostcoGrs;
    private fetchPage;
}
