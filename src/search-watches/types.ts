import type { SearchResult } from "../discovery/types.js";

export type RetailerSearchWatch = {
  id: string;
  domain: string;
  query: string;
  cadenceMinutes: number;
  enabled: boolean;
  notifyOnInitialResults: boolean;
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
  searchQuery: string;
  checkedAt: string;
  matchedResults: number;
  newResults: RetailerSearchWatchResult[];
  baselineEstablished: boolean;
  notificationsRecommended: number;
  dryRun: boolean;
};
