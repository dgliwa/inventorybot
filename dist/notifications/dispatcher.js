export class NotificationDispatcher {
    database;
    channels;
    options;
    now;
    constructor(database, channels, options = {}, now = () => new Date()) {
        this.database = database;
        this.channels = channels;
        this.options = options;
        this.now = now;
    }
    async dispatch(options = {}) {
        if (this.channels.size === 0) {
            return { claimed: 0, sent: 0, handedOff: 0, suppressed: 0, failed: 0, terminal: 0 };
        }
        const maxAttempts = this.options.maxAttempts ?? 6;
        const notifications = this.database.claimNotifications({
            now: this.now().toISOString(),
            limit: this.options.batchSize ?? 25,
            leaseMs: this.options.leaseMs ?? 60_000,
        });
        const summary = {
            claimed: notifications.length,
            sent: 0,
            handedOff: 0,
            suppressed: 0,
            failed: 0,
            terminal: 0,
        };
        for (const notification of notifications) {
            options.signal?.throwIfAborted();
            const channel = this.channels.get(notification.channel);
            try {
                if (!channel)
                    throw new Error(`Notification channel ${notification.channel} is unavailable.`);
                const result = await channel.send(notification, options);
                const updatedAt = this.now().toISOString();
                if (result.status === "delivered") {
                    this.database.markNotificationSent(notification.id, result.providerMessageId, updatedAt, result.durableIntentId);
                    summary.sent += 1;
                }
                else if (result.status === "handed_off") {
                    this.database.markNotificationHandedOff(notification.id, {
                        deliveryIntentId: result.durableIntentId,
                        error: result.error,
                        updatedAt,
                    });
                    summary.handedOff += 1;
                }
                else {
                    this.database.markNotificationSuppressed(notification.id, {
                        deliveryIntentId: result.durableIntentId,
                        reason: result.reason,
                        updatedAt,
                    });
                    summary.suppressed += 1;
                }
            }
            catch (error) {
                const terminal = notification.attemptCount >= maxAttempts;
                const retryMs = Math.min((this.options.baseRetryMs ?? 30_000) * 2 ** Math.max(0, notification.attemptCount - 1), 60 * 60_000);
                this.database.markNotificationFailed(notification.id, {
                    error: error instanceof Error ? error.message : String(error),
                    terminal,
                    nextAttemptAt: new Date(this.now().getTime() + retryMs).toISOString(),
                    updatedAt: this.now().toISOString(),
                });
                summary.failed += 1;
                if (terminal)
                    summary.terminal += 1;
            }
        }
        return summary;
    }
}
