import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { NotificationChannel, NotificationDeliveryResult, NotificationPayload, PendingNotification } from "./types.js";
export declare function formatInventoryNotification(payload: NotificationPayload): string;
type DurableSend = typeof sendDurableMessageBatch;
export declare class OpenClawDiscordChannel implements NotificationChannel {
    #private;
    private readonly config;
    private readonly options;
    readonly id = "discord";
    constructor(config: OpenClawConfig, options?: {
        maxRetries?: number;
        durableSend?: DurableSend;
    });
    send(notification: PendingNotification, options?: {
        signal?: AbortSignal;
    }): Promise<NotificationDeliveryResult>;
}
export {};
