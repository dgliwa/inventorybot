import type { SearchResult } from "../discovery/types.js";
import { type HostResolver } from "../inspection/url-safety.js";
import type { DeterministicSearchAdapter, DeterministicSearchClient } from "./types.js";
export type SearchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class SearchAdapterDiscoveryError extends Error {
    readonly code: string;
    readonly nextAction: string;
    constructor(code: string, message: string, nextAction: string);
}
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
    private fetchPage;
}
