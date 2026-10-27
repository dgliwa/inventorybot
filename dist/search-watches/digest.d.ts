import type { InventoryDatabase } from "../persistence/db.js";
export type DiscoveryDigestTarget = {
    channel: string;
    target: string;
    accountId?: string;
    threadId?: string;
};
export type DiscoveryDigestResult = {
    localDate: string;
    alreadyCompleted: boolean;
    events: number;
    notificationQueued: boolean;
};
export declare class DiscoveryDigestService {
    private readonly database;
    private readonly now;
    constructor(database: InventoryDatabase, now?: () => Date);
    run(options?: {
        target?: DiscoveryDigestTarget;
        force?: boolean;
        digestHourLocal?: number;
    }): DiscoveryDigestResult;
}
