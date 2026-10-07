import type { RetailerSearchClient, SearchResult } from "./types.js";
type RuntimeSearch = (params: {
    args: Record<string, unknown>;
    signal?: AbortSignal;
}) => Promise<{
    provider: string;
    result: Record<string, unknown>;
}>;
export declare function normalizeSearchResults(payload: Record<string, unknown>): SearchResult[];
export declare class OpenClawSearchClient implements RetailerSearchClient {
    private readonly runtimeSearch;
    constructor(runtimeSearch: RuntimeSearch);
    search(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]>;
}
export {};
