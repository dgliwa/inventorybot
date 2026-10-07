import type { AdapterRegistry } from "../adapters/registry.js";
import type { RetailerSearchClient } from "../discovery/types.js";
import { validateRetailerAdapter } from "../generation/validate-adapter.js";
import { inspectRetailerStatic } from "../inspection/static.js";
import type { NotificationChannel } from "../notifications/types.js";
import type { InventoryDatabase } from "../persistence/db.js";
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
export type SlowMonitorSummary = {
    watchesConsidered: number;
    discoveries: number;
    candidatesFound: number;
    targetsInspected: number;
    adapterCandidatesGenerated: number;
    adapterCandidatesValidated: number;
    failures: number;
};
type MonitorDependencies = {
    databaseFactory: () => InventoryDatabase;
    registry?: AdapterRegistry;
    registryFactory?: (database: InventoryDatabase) => AdapterRegistry;
    config: InventoryBotConfig;
    searchClient?: RetailerSearchClient;
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
        };
        intervals: {
            fastSeconds: number;
            slowHours: number;
        };
    };
    runFast(options?: {
        signal?: AbortSignal;
        deliverNotifications?: boolean;
    }): Promise<FastMonitorSummary>;
    runSlow(options?: {
        signal?: AbortSignal;
    }): Promise<SlowMonitorSummary>;
    private combineWithLifecycleSignal;
    private scheduleFast;
    private scheduleSlow;
    private executeFast;
    private executeSlow;
    private generateAndValidateCandidate;
}
export {};
