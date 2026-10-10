import { type HostResolver } from "../inspection/url-safety.js";
import type { SearchResult } from "../discovery/types.js";
import type { TargetRedskySearchAdapter } from "./types.js";
import { type SearchFetch } from "./parsing.js";
export declare function discoverTargetConfig(html: string, now: Date): TargetRedskySearchAdapter;
export declare function searchTarget(adapter: TargetRedskySearchAdapter, query: string, count: number, fetchImpl: SearchFetch, resolver?: HostResolver, signal?: AbortSignal): Promise<SearchResult[]>;
