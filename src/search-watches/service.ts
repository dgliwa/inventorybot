import { randomUUID } from "node:crypto";
import { domainMatches, normalizeDomain } from "../adapters/url.js";
import type { SearchResult } from "../discovery/types.js";
import type { NotificationPayload } from "../notifications/types.js";
import type { InventoryDatabase } from "../persistence/db.js";
import type {
  DeterministicSearchClient,
  RetailerSearchWatch,
  SearchWatchRunResult,
} from "./types.js";

export type SearchWatchNotificationTarget = {
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string;
};

function cleanText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchesInterest(result: SearchResult, query: string): boolean {
  const interest = cleanText(query);
  const haystack = cleanText([result.title, result.snippet, result.url].filter(Boolean).join(" "));
  if (!interest) return false;
  if (haystack.includes(interest)) return true;
  const tokens = interest.split(" ").filter((token) => token.length > 1);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function canonicalResult(result: SearchResult, domain: string): SearchResult | undefined {
  try {
    const url = new URL(result.url);
    if (!domainMatches(normalizeDomain(url.toString()), domain)) return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["ref", "campaign"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return {
      url: url.toString(),
      ...(result.title?.trim() ? { title: result.title.trim() } : {}),
      ...(result.snippet?.trim() ? { snippet: result.snippet.trim() } : {}),
    };
  } catch {
    return undefined;
  }
}

export class SearchWatchService {
  constructor(
    private readonly database: InventoryDatabase,
    private readonly searchClient: DeterministicSearchClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async add(input: {
    domain: string;
    query: string;
    cadenceMinutes?: number;
    enabled?: boolean;
    notifyOnInitialResults?: boolean;
    signal?: AbortSignal;
  }): Promise<RetailerSearchWatch & { validationResults: SearchResult[] }> {
    const domain = normalizeDomain(input.domain.includes("://") ? input.domain : `https://${input.domain}`);
    const query = input.query.trim();
    if (!query) throw new Error("Search interest must not be empty.");
    const cadenceMinutes = input.cadenceMinutes ?? 60;
    if (!Number.isInteger(cadenceMinutes) || cadenceMinutes < 5) {
      throw new Error("Search cadence must be an integer of at least 5 minutes.");
    }
    input.signal?.throwIfAborted();
    const discovery = await this.searchClient.discover(domain, query, input.signal);
    input.signal?.throwIfAborted();
    const now = this.now().toISOString();
    const watch = this.database.createSearchWatch({
      id: randomUUID(),
      domain,
      query,
      cadenceMinutes,
      enabled: input.enabled ?? true,
      notifyOnInitialResults: input.notifyOnInitialResults ?? false,
      adapter: discovery.adapter,
      createdAt: now,
      updatedAt: now,
    });
    return { ...watch, validationResults: discovery.results };
  }

  async update(input: {
    watchId: string;
    domain?: string;
    query?: string;
    cadenceMinutes?: number;
    enabled?: boolean;
    notifyOnInitialResults?: boolean;
    signal?: AbortSignal;
  }): Promise<RetailerSearchWatch | undefined> {
    const current = this.database.getSearchWatch(input.watchId);
    if (!current) return undefined;
    const domain = input.domain === undefined
      ? current.domain
      : normalizeDomain(input.domain.includes("://") ? input.domain : `https://${input.domain}`);
    const query = input.query === undefined ? current.query : input.query.trim();
    if (!query) throw new Error("Search interest must not be empty.");
    if (input.cadenceMinutes !== undefined && (!Number.isInteger(input.cadenceMinutes) || input.cadenceMinutes < 5)) {
      throw new Error("Search cadence must be an integer of at least 5 minutes.");
    }
    const resetBaseline = domain !== current.domain || query !== current.query;
    let adapter = current.adapter;
    if (resetBaseline || !adapter) {
      input.signal?.throwIfAborted();
      adapter = (await this.searchClient.discover(domain, query, input.signal)).adapter;
    }
    return this.database.updateSearchWatch(input.watchId, {
      domain,
      query,
      cadenceMinutes: input.cadenceMinutes,
      enabled: input.enabled,
      notifyOnInitialResults: input.notifyOnInitialResults,
      adapter,
      updatedAt: this.now().toISOString(),
      resetBaseline,
    });
  }

  status(watchId?: string): Array<RetailerSearchWatch & { recentResults: ReturnType<InventoryDatabase["listSearchWatchResults"]> }> {
    const watches = watchId
      ? [this.database.getSearchWatch(watchId)].filter((watch): watch is RetailerSearchWatch => Boolean(watch))
      : this.database.listSearchWatches();
    return watches.map((watch) => ({
      ...watch,
      recentResults: this.database.listSearchWatchResults(watch.id),
    }));
  }

  remove(watchId: string, permanent = false): { watchId: string; disabled: boolean; removed: boolean } {
    if (permanent) {
      return { watchId, disabled: false, removed: this.database.removeSearchWatch(watchId) };
    }
    return {
      watchId,
      disabled: this.database.disableSearchWatch(watchId, this.now().toISOString()),
      removed: false,
    };
  }

  async run(
    watchId: string,
    options: {
      signal?: AbortSignal;
      dryRun?: boolean;
      notification?: SearchWatchNotificationTarget;
      resultsPerSearch?: number;
    } = {},
  ): Promise<SearchWatchRunResult> {
    options.signal?.throwIfAborted();
    const watch = this.database.getSearchWatch(watchId);
    if (!watch) throw new Error(`No search watch exists with id ${watchId}.`);
    if (!watch.adapter) {
      throw new Error(`Search watch ${watchId} has no validated deterministic adapter and must be re-registered.`);
    }
    const raw = await this.searchClient.search(
      watch.adapter,
      watch.query,
      options.resultsPerSearch ?? 50,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const unique = new Map<string, SearchResult>();
    for (const result of raw) {
      const canonical = canonicalResult(result, watch.domain);
      if (canonical && matchesInterest(canonical, watch.query)) unique.set(canonical.url, canonical);
    }
    const checkedAt = this.now().toISOString();
    const nextCheckAt = new Date(Date.parse(checkedAt) + watch.cadenceMinutes * 60_000).toISOString();
    const baselineEstablished = !watch.lastCheckedAt;
    const suppressInitial = baselineEstablished && !watch.notifyOnInitialResults;
    const results = [...unique.values()];
    const newResults = options.dryRun
      ? results.map((result) => ({ ...result, firstSeenAt: checkedAt, lastSeenAt: checkedAt }))
      : this.database.recordSearchWatchResults({
          watchId: watch.id,
          results,
          checkedAt,
          nextCheckAt,
        });
    let notificationsRecommended = 0;
    if (!options.dryRun && options.notification && !suppressInitial) {
      for (const result of newResults) {
        const payload: NotificationPayload = {
          kind: "search_result",
          watchId: watch.id,
          productName: result.title ?? watch.query,
          resultTitle: result.title,
          resultSnippet: result.snippet,
          retailerDomain: watch.domain,
          url: result.url,
          currentStatus: "new_search_result",
          checkedAt,
        };
        if (this.database.enqueueNotification({
          sourceKind: "search_watch",
          sourceId: watch.id,
          fingerprint: `search:${watch.id}:${result.url}`,
          channel: options.notification.channel,
          target: options.notification.target,
          accountId: options.notification.accountId,
          threadId: options.notification.threadId,
          transition: "new_search_result",
          payload,
          createdAt: checkedAt,
        })) notificationsRecommended += 1;
      }
    }
    const searchUrl = new URL(watch.adapter.searchUrl);
    for (const [key, value] of Object.entries(watch.adapter.fixedParameters)) searchUrl.searchParams.set(key, value);
    searchUrl.searchParams.set(watch.adapter.queryParameter, watch.query);
    return {
      watchId: watch.id,
      domain: watch.domain,
      query: watch.query,
      searchUrl: searchUrl.toString(),
      checkedAt,
      matchedResults: results.length,
      newResults,
      baselineEstablished,
      notificationsRecommended,
      dryRun: options.dryRun === true,
    };
  }
}
