import type { RetailerSearchClient } from "../discovery/types.js";
import type { InventoryDatabase } from "../persistence/db.js";
import type { RetailerSearchWatch, SearchWatchRunResult } from "./types.js";
export type SearchWatchNotificationTarget = {
    channel: string;
    target: string;
    accountId?: string;
    threadId?: string;
};
export declare class SearchWatchService {
    private readonly database;
    private readonly searchClient;
    private readonly now;
    constructor(database: InventoryDatabase, searchClient: RetailerSearchClient, now?: () => Date);
    add(input: {
        domain: string;
        query: string;
        cadenceMinutes?: number;
        enabled?: boolean;
        notifyOnInitialResults?: boolean;
    }): RetailerSearchWatch;
    update(input: {
        watchId: string;
        domain?: string;
        query?: string;
        cadenceMinutes?: number;
        enabled?: boolean;
        notifyOnInitialResults?: boolean;
    }): RetailerSearchWatch | undefined;
    status(watchId?: string): Array<RetailerSearchWatch & {
        recentResults: ReturnType<InventoryDatabase["listSearchWatchResults"]>;
    }>;
    remove(watchId: string, permanent?: boolean): {
        watchId: string;
        disabled: boolean;
        removed: boolean;
    };
    run(watchId: string, options?: {
        signal?: AbortSignal;
        dryRun?: boolean;
        notification?: SearchWatchNotificationTarget;
        resultsPerSearch?: number;
    }): Promise<SearchWatchRunResult>;
}
