import { randomUUID } from "node:crypto";
import { domainMatches, normalizeDomain } from "../adapters/url.js";
function cleanText(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function matchesInterest(result, query) {
    const interest = cleanText(query);
    const haystack = cleanText([result.title, result.snippet, result.url].filter(Boolean).join(" "));
    if (!interest)
        return false;
    if (haystack.includes(interest))
        return true;
    const tokens = interest.split(" ").filter((token) => token.length > 1);
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}
function cleanResultText(value) {
    if (!value || /^<<ccr:[^>]+>>$/i.test(value.trim()))
        return undefined;
    const cleaned = value
        .split("\n")
        .filter((line) => !line.startsWith("<<<EXTERNAL_UNTRUSTED_CONTENT") &&
        !line.startsWith("<<<END_EXTERNAL_UNTRUSTED_CONTENT") &&
        !line.startsWith("Source: Web Search") &&
        line.trim() !== "---")
        .join("\n")
        .trim();
    return cleaned || undefined;
}
function canonicalResult(result, domain) {
    try {
        const url = new URL(result.url);
        if (!domainMatches(normalizeDomain(url.toString()), domain))
            return undefined;
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
            if (key.toLowerCase().startsWith("utm_") || ["ref", "source", "campaign"].includes(key.toLowerCase())) {
                url.searchParams.delete(key);
            }
        }
        if (url.pathname.length > 1)
            url.pathname = url.pathname.replace(/\/+$/, "");
        const title = cleanResultText(result.title);
        const snippet = cleanResultText(result.snippet);
        return {
            url: url.toString(),
            ...(title ? { title } : {}),
            ...(snippet ? { snippet } : {}),
        };
    }
    catch {
        return undefined;
    }
}
function searchQuery(watch) {
    return `site:${watch.domain} "${watch.query.replaceAll('"', " ").trim()}"`;
}
export class SearchWatchService {
    database;
    searchClient;
    now;
    constructor(database, searchClient, now = () => new Date()) {
        this.database = database;
        this.searchClient = searchClient;
        this.now = now;
    }
    add(input) {
        const now = this.now().toISOString();
        const domain = normalizeDomain(input.domain.includes("://") ? input.domain : `https://${input.domain}`);
        const query = input.query.trim();
        if (!query)
            throw new Error("Search interest must not be empty.");
        const cadenceMinutes = input.cadenceMinutes ?? 60;
        if (!Number.isInteger(cadenceMinutes) || cadenceMinutes < 5) {
            throw new Error("Search cadence must be an integer of at least 5 minutes.");
        }
        return this.database.createSearchWatch({
            id: randomUUID(),
            domain,
            query,
            cadenceMinutes,
            enabled: input.enabled ?? true,
            notifyOnInitialResults: input.notifyOnInitialResults ?? false,
            createdAt: now,
            updatedAt: now,
        });
    }
    update(input) {
        const current = this.database.getSearchWatch(input.watchId);
        if (!current)
            return undefined;
        const domain = input.domain === undefined
            ? undefined
            : normalizeDomain(input.domain.includes("://") ? input.domain : `https://${input.domain}`);
        const query = input.query?.trim();
        if (input.query !== undefined && !query)
            throw new Error("Search interest must not be empty.");
        if (input.cadenceMinutes !== undefined &&
            (!Number.isInteger(input.cadenceMinutes) || input.cadenceMinutes < 5)) {
            throw new Error("Search cadence must be an integer of at least 5 minutes.");
        }
        const resetBaseline = (domain !== undefined && domain !== current.domain) ||
            (query !== undefined && query !== current.query);
        return this.database.updateSearchWatch(input.watchId, {
            domain,
            query,
            cadenceMinutes: input.cadenceMinutes,
            enabled: input.enabled,
            notifyOnInitialResults: input.notifyOnInitialResults,
            updatedAt: this.now().toISOString(),
            resetBaseline,
        });
    }
    status(watchId) {
        const watches = watchId
            ? [this.database.getSearchWatch(watchId)].filter((watch) => Boolean(watch))
            : this.database.listSearchWatches();
        return watches.map((watch) => ({
            ...watch,
            recentResults: this.database.listSearchWatchResults(watch.id),
        }));
    }
    remove(watchId, permanent = false) {
        if (permanent) {
            return { watchId, disabled: false, removed: this.database.removeSearchWatch(watchId) };
        }
        return {
            watchId,
            disabled: this.database.disableSearchWatch(watchId, this.now().toISOString()),
            removed: false,
        };
    }
    async run(watchId, options = {}) {
        options.signal?.throwIfAborted();
        const watch = this.database.getSearchWatch(watchId);
        if (!watch)
            throw new Error(`Search watch ${watchId} was not found.`);
        const query = searchQuery(watch);
        const raw = await this.searchClient.search(query, options.resultsPerSearch ?? 20, options.signal);
        options.signal?.throwIfAborted();
        const unique = new Map();
        for (const result of raw) {
            const canonical = canonicalResult(result, watch.domain);
            if (canonical && matchesInterest(canonical, watch.query))
                unique.set(canonical.url, canonical);
        }
        const checkedAt = this.now().toISOString();
        const nextCheckAt = new Date(Date.parse(checkedAt) + watch.cadenceMinutes * 60_000).toISOString();
        const initialRun = !watch.lastCheckedAt;
        const baselineEstablished = initialRun && !watch.notifyOnInitialResults;
        const results = [...unique.values()];
        const newResults = options.dryRun
            ? results.map((result) => ({ ...result, firstSeenAt: checkedAt, lastSeenAt: checkedAt }))
            : this.database.recordSearchWatchResults({ watchId, results, checkedAt, nextCheckAt });
        let notificationsRecommended = 0;
        if (!options.dryRun && !baselineEstablished && options.notification) {
            for (const result of newResults) {
                const payload = {
                    kind: "search_result",
                    searchWatchId: watch.id,
                    searchQuery: watch.query,
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
                }))
                    notificationsRecommended += 1;
            }
        }
        return {
            watchId: watch.id,
            domain: watch.domain,
            query: watch.query,
            searchQuery: query,
            checkedAt,
            matchedResults: results.length,
            newResults,
            baselineEstablished,
            notificationsRecommended,
            dryRun: options.dryRun === true,
        };
    }
}
