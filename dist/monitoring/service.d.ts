import type { AdapterRegistry } from "../adapters/registry.js";
import type { RetailerSearchClient } from "../discovery/types.js";
import { validateRetailerAdapter } from "../generation/validate-adapter.js";
import { inspectRetailerStatic } from "../inspection/static.js";
import type { NotificationChannel } from "../notifications/types.js";
import type { InventoryDatabase } from "../persistence/db.js";
import type { DeterministicSearchClient, SearchWatchRunResult } from "../search-watches/types.js";
import type { InventoryBotConfig } from "./config.js";
export type FastMonitorSummary = {
    watches: number;
    checkedTargets: number;
    watchFailures: number;
    notificationsRecommended: number;
    delivery: {
        claimed: number;
        sent: number;
        failed: number;
        terminal: number;
    };
};
export type SearchMonitorSummary = {
    watchesConsidered: number;
    watchesRun: number;
    failures: number;
    newResults: number;
    notificationsRecommended: number;
    results: SearchWatchRunResult[];
    delivery: {
        claimed: number;
        sent: number;
        failed: number;
        terminal: number;
    };
    dryRun?: true;
};
export type SlowMonitorSummary = {
    watchesConsidered: number;
    discoveries: number;
    candidatesFound: number;
    targetsInspected: number;
    adapterCandidatesGenerated: number;
    adapterCandidatesValidated: number;
    failures: number;
    dryRun?: true;
    preview?: {
        staleWatches: number;
        inspectableTargets: number;
    };
};
type MonitorDependencies = {
    databaseFactory: () => InventoryDatabase;
    registry?: AdapterRegistry;
    registryFactory?: (database: InventoryDatabase) => AdapterRegistry;
    config: InventoryBotConfig;
    searchClient?: RetailerSearchClient;
    deterministicSearchClient: DeterministicSearchClient;
    notificationChannels?: ReadonlyMap<string, NotificationChannel>;
    inspect?: typeof inspectRetailerStatic;
    validate?: typeof validateRetailerAdapter;
    log?: (event: Record<string, unknown>) => void;
    now?: () => Date;
};
export declare class InventoryMonitor {
    #private;
    constructor(dependencies: MonitorDependencies);
    start(): void;
    stop(): Promise<void>;
    status(): {
        enabled: boolean;
        running: {
            fast: boolean;
            slow: boolean;
            search: boolean;
        };
        intervals: {
            fastSeconds: number;
            slowHours: number;
        };
    };
    runFast(options?: {
        signal?: AbortSignal;
        deliverNotifications?: boolean;
        watchIds?: string[];
    }): Promise<FastMonitorSummary>;
    runSlow(options?: {
        signal?: AbortSignal;
        watchIds?: string[];
        dryRun?: boolean;
    }): Promise<SlowMonitorSummary>;
    runSearch(options?: {
        signal?: AbortSignal;
        watchIds?: string[];
        dryRun?: boolean;
        deliverNotifications?: boolean;
        dueOnly?: boolean;
    }): Promise<SearchMonitorSummary>;
    private combineWithLifecycleSignal;
    private scheduleFast;
    private scheduleSlow;
    private scheduleSearch;
    private executeSearch;
    private executeFast;
    private previewSlow;
    private executeSlow;
    private generateAndValidateCandidate;
}
export {};
