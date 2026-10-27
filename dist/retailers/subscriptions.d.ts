import type { InventoryDatabase } from "../persistence/db.js";
import type { RetailerSubscription } from "./types.js";
export declare class RetailerSubscriptionService {
    private readonly database;
    private readonly now;
    constructor(database: InventoryDatabase, now?: () => Date);
    add(input: {
        domain: string;
        postalCode: string;
        radiusMiles?: number;
        stores?: Array<{
            storeId: string;
            name: string;
            address?: string;
            primary?: boolean;
        }>;
        enabled?: boolean;
    }): RetailerSubscription;
    update(input: {
        subscriptionId: string;
        postalCode?: string;
        radiusMiles?: number;
        stores?: Array<{
            storeId: string;
            name: string;
            address?: string;
            primary?: boolean;
        }>;
        enabled?: boolean;
    }): RetailerSubscription | undefined;
    status(subscriptionId?: string): RetailerSubscription | RetailerSubscription[] | undefined;
    remove(subscriptionId: string): boolean;
}
