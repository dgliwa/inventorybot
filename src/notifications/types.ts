import type { FulfillmentResult } from "../domain/inventory.js";

export type NotificationPayload = {
  kind: "inventory_transition" | "search_result" | "discovery_digest" | "test";
  watchId?: string;
  targetId?: string;
  productName: string;
  productSku?: string;
  retailerDomain?: string;
  url?: string;
  previousStatus?: string;
  currentStatus: string;
  price?: number;
  currency?: string;
  confidence?: number;
  fulfillment?: FulfillmentResult;
  checkedAt: string;
  searchWatchId?: string;
  searchQuery?: string;
  resultTitle?: string;
  resultSnippet?: string;
  discoveryGroups?: Array<{
retailerDomain: string;
searchQuery: string;
watchId: string;
results: Array<{
title: string;
url: string;
snippet?: string;
discoveryKind: "new" | "returned";
observedAt: string;
present: boolean;
listingKind: "catalog_listing";
availability: "not_checked";
}>;
}>;
searchResults?: Array<{
    title: string;
    url: string;
    snippet?: string;
    listingKind?: "catalog_listing";
    availability?: "not_checked";
    reappeared?: boolean;
  }>;
};

export type PendingNotification = {
  id: number;
  fingerprint: string;
  channel: string;
  target: string;
  accountId?: string;
  threadId?: string;
  payload: NotificationPayload;
  attemptCount: number;
};

export type NotificationDeliveryResult =
  | {
      status: "delivered";
      providerMessageId: string;
      durableIntentId?: string;
    }
  | {
      status: "handed_off";
      durableIntentId: string;
      error?: string;
    }
  | {
      status: "suppressed";
      durableIntentId?: string;
      reason: string;
    };

export interface NotificationChannel {
  readonly id: string;
  send(
    notification: PendingNotification,
    options?: { signal?: AbortSignal },
  ): Promise<NotificationDeliveryResult>;
}

export type NotificationDispatchSummary = {
  claimed: number;
  sent: number;
  handedOff: number;
  suppressed: number;
  failed: number;
  terminal: number;
};
