function record(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function number(value, fallback, minimum, maximum) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.min(maximum, Math.max(minimum, value))
        : fallback;
}
export function parseInventoryBotConfig(value) {
    const root = record(value);
    const persistence = record(root.persistence);
    const monitoring = record(root.monitoring);
    const searchMonitoring = record(root.searchMonitoring);
    const notifications = record(root.notifications);
    const discord = record(notifications.discord);
    return {
        ...(typeof persistence.databasePath === "string"
            ? { persistence: { databasePath: persistence.databasePath } }
            : {}),
        adapterPromotion: { mode: "manual" },
        monitoring: {
            enabled: monitoring.enabled === true,
            fastIntervalSeconds: number(monitoring.fastIntervalSeconds, 120, 30, 86_400),
            slowIntervalHours: number(monitoring.slowIntervalHours, 12, 1, 720),
            rediscoveryAfterHours: number(monitoring.rediscoveryAfterHours, 168, 1, 8_760),
            inspectAfterUnknownCount: number(monitoring.inspectAfterUnknownCount, 3, 1, 100),
            timeoutMs: number(monitoring.timeoutMs, 10_000, 1_000, 60_000),
            maxConcurrency: number(monitoring.maxConcurrency, 4, 1, 20),
            perDomainConcurrency: number(monitoring.perDomainConcurrency, 1, 1, 10),
            jitterSeconds: number(monitoring.jitterSeconds, 15, 0, 3_600),
            notifyWhenUnavailable: monitoring.notifyWhenUnavailable === true,
        },
        searchMonitoring: {
            enabled: searchMonitoring.enabled === true,
        },
        notifications: {
            ...(discord.enabled === true && typeof discord.target === "string" && discord.target.trim()
                ? {
                    discord: {
                        enabled: true,
                        target: discord.target.trim(),
                        ...(typeof discord.accountId === "string" ? { accountId: discord.accountId } : {}),
                        ...(typeof discord.threadId === "string" ? { threadId: discord.threadId } : {}),
                    },
                }
                : {}),
            maxAttempts: number(notifications.maxAttempts, 6, 1, 20),
            batchSize: number(notifications.batchSize, 25, 1, 100),
            baseRetrySeconds: number(notifications.baseRetrySeconds, 30, 1, 3_600),
        },
    };
}
