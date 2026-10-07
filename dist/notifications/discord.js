import { sendDurableMessageBatch, } from "openclaw/plugin-sdk/channel-outbound";
export function formatInventoryNotification(payload) {
    if (payload.kind === "test") {
        return `🔔 InventoryBot test notification\n\nConfigured delivery is working.\n${payload.checkedAt}`;
    }
    const available = payload.currentStatus === "in_stock";
    const lines = [
        available ? `🟢 ${payload.productName} is in stock` : `🔴 ${payload.productName} is unavailable`,
        "",
    ];
    if (payload.productSku)
        lines.push(`SKU: ${payload.productSku}`);
    if (payload.retailerDomain)
        lines.push(`Retailer: ${payload.retailerDomain}`);
    if (payload.price !== undefined) {
        lines.push(`Price: ${payload.currency ? `${payload.currency} ` : ""}${payload.price.toFixed(2)}`);
    }
    if (payload.confidence !== undefined) {
        lines.push(`Confidence: ${Math.round(payload.confidence * 100)}%`);
    }
    lines.push(`Transition: ${payload.previousStatus ?? "unobserved"} → ${payload.currentStatus}`);
    lines.push(`Checked: ${payload.checkedAt}`);
    if (payload.url)
        lines.push("", payload.url);
    return lines.join("\n");
}
function errorMessage(result) {
    return result.error instanceof Error ? result.error.message : String(result.error);
}
export class OpenClawDiscordChannel {
    config;
    options;
    id = "discord";
    #durableSend;
    constructor(config, options = {}) {
        this.config = config;
        this.options = options;
        this.#durableSend = options.durableSend ?? sendDurableMessageBatch;
    }
    async send(notification, options = {}) {
        const stableIntentId = `inventorybot:${notification.fingerprint}`;
        let durableIntentId;
        options.signal?.throwIfAborted();
        let result;
        try {
            result = await this.#durableSend({
                cfg: this.config,
                channel: "discord",
                to: notification.target,
                accountId: notification.accountId,
                threadId: notification.threadId,
                payloads: [{ text: formatInventoryNotification(notification.payload) }],
                durability: "required",
                signal: options.signal,
                deliveryIntentId: stableIntentId,
                reusePendingDeliveryIntent: true,
                maxRetries: this.options.maxRetries,
                completionRetention: {
                    idPrefix: "inventorybot:",
                    maxAgeMs: 30 * 24 * 60 * 60_000,
                    maxEntries: 100_000,
                },
                onDeliveryIntent: (intent) => { durableIntentId = intent.id; },
            });
        }
        catch (error) {
            if (durableIntentId) {
                return {
                    status: "handed_off",
                    durableIntentId,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            throw error;
        }
        if (result.status === "sent") {
            const providerMessageId = result.results.find(({ messageId }) => messageId)?.messageId;
            if (!providerMessageId) {
                throw new Error("OpenClaw reported delivery without a provider message ID.");
            }
            return { status: "delivered", providerMessageId, durableIntentId };
        }
        if (result.status === "partial_failed" && result.results.length > 0) {
            const providerMessageId = result.results.find(({ messageId }) => messageId)?.messageId;
            if (providerMessageId) {
                return { status: "delivered", providerMessageId, durableIntentId };
            }
        }
        if (result.status === "suppressed") {
            if (result.reason === "no_visible_result") {
                return { status: "handed_off", durableIntentId: durableIntentId ?? stableIntentId };
            }
            return { status: "suppressed", durableIntentId, reason: result.reason };
        }
        if (durableIntentId) {
            return {
                status: "handed_off",
                durableIntentId,
                error: errorMessage(result),
            };
        }
        throw new Error(errorMessage(result));
    }
}
