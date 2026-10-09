import type { SearchResult } from "../discovery/types.js";

type SearchAdapterMetadata = {
  version: 1;
  domain: string;
  validatedAt: string;
  validationResultCount: number;
};

export type HtmlGetSearchAdapter = SearchAdapterMetadata & {
  kind: "html_get";
  searchUrl: string;
  queryParameter: string;
  fixedParameters: Record<string, string>;
  parser: "html_links";
};

export type CostcoGrsSearchAdapter = SearchAdapterMetadata & {
  kind: "costco_grs";
  searchUrl: string;
  clientIdentifier: string;
  clientId: "USBC";
  locale: "en-US";
  warehouseId: string;
  parser: "costco_grs_v1";
};

export type DeterministicSearchAdapter = HtmlGetSearchAdapter | CostcoGrsSearchAdapter;

export type RetailerSearchWatch = {
  id: string;
  domain: string;
  query: string;
  cadenceMinutes: number;
  enabled: boolean;
  notifyOnInitialResults: boolean;
  adapter?: DeterministicSearchAdapter;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
};

export type RetailerSearchWatchResult = SearchResult & {
  firstSeenAt: string;
  lastSeenAt: string;
};

export type SearchWatchRunResult = {
  watchId: string;
  domain: string;
  query: string;
  searchUrl: string;
  checkedAt: string;
  matchedResults: number;
  newResults: RetailerSearchWatchResult[];
  baselineEstablished: boolean;
  notificationsRecommended: number;
  dryRun: boolean;
};

export interface DeterministicSearchClient {
  discover(
    domain: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<{ adapter: DeterministicSearchAdapter; results: SearchResult[] }>;
  search(
    adapter: DeterministicSearchAdapter,
    query: string,
    count: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]>;
}
