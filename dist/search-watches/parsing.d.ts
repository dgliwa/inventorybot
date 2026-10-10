import type { SearchResult } from "../discovery/types.js";
export type SearchFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class SearchAdapterDiscoveryError extends Error {
    readonly code: string;
    readonly nextAction: string;
    constructor(code: string, message: string, nextAction: string);
}
export declare function decodeHtml(value: string): string;
export declare function textContent(value: string): string;
export declare function matchesQuery(result: SearchResult, query: string): boolean;
export declare function readBounded(response: Response, maximumBytes?: number): Promise<string>;
