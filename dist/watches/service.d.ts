import type { AdapterRegistry } from "../adapters/registry.js";
import type { ProductIdentity } from "../domain/product.js";
import type { InventoryDatabase } from "../persistence/db.js";
import type { InventoryWatch, WatchRun } from "./types.js";
export type WatchLogRecord = {
    watch_id: string;
    product_id: string;
    domain: string;
    url: string;
    adapter_id?: string;
    adapter_version?: string;
    status: string;
    confidence: number;
    method: string;
    duration_ms: number;
    checked_at: string;
};
export declare class WatchService {
    private readonly database;
    private readonly registry;
    private readonly log;
    private readonly now;
    private readonly checkGate;
    constructor(database: InventoryDatabase, registry: AdapterRegistry, log?: (record: WatchLogRecord) => void, now?: () => Date, checkGate?: <T>(domain: string, operation: () => Promise<T>) => Promise<T>);
    add(input: {
        product: ProductIdentity;
        retailers: Array<{
            url: string;
            enabled?: boolean;
        }>;
        enabled?: boolean;
    }, options?: {
        signal?: AbortSignal;
    }): InventoryWatch;
    remove(watchId: string, options?: {
        permanent?: boolean;
        signal?: AbortSignal;
    }): {
        watchId: string;
        disabled: boolean;
        removed: boolean;
    };
    status(watchId?: string): InventoryWatch | InventoryWatch[] | undefined;
    private withAdapterReadiness;
    run(watchId: string, options?: {
        timeoutMs?: number;
        notifyWhenUnavailable?: boolean;
        signal?: AbortSignal;
        notification?: {
            channel: string;
            target: string;
            accountId?: string;
            threadId?: string;
        };
    }): Promise<WatchRun>;
}
