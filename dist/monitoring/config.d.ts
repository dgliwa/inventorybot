export type InventoryBotConfig = {
    persistence?: {
        databasePath?: string;
    };
    adapterPromotion?: {
        mode: "manual";
    };
    monitoring: {
        enabled: boolean;
        fastIntervalSeconds: number;
        slowIntervalHours: number;
        rediscoveryAfterHours: number;
        inspectAfterUnknownCount: number;
        timeoutMs: number;
        maxConcurrency: number;
        perDomainConcurrency: number;
        jitterSeconds: number;
        notifyWhenUnavailable: boolean;
    };
    notifications: {
        discord?: {
            enabled: boolean;
            target: string;
            accountId?: string;
            threadId?: string;
        };
        maxAttempts: number;
        batchSize: number;
        baseRetrySeconds: number;
    };
};
export declare function parseInventoryBotConfig(value: unknown): InventoryBotConfig;
