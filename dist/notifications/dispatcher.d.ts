import type { InventoryDatabase } from "../persistence/db.js";
import type { NotificationChannel, NotificationDispatchSummary } from "./types.js";
export declare class NotificationDispatcher {
    private readonly database;
    private readonly channels;
    private readonly options;
    private readonly now;
    constructor(database: InventoryDatabase, channels: ReadonlyMap<string, NotificationChannel>, options?: {
        maxAttempts?: number;
        batchSize?: number;
        baseRetryMs?: number;
        leaseMs?: number;
    }, now?: () => Date);
    dispatch(options?: {
        signal?: AbortSignal;
    }): Promise<NotificationDispatchSummary>;
}
