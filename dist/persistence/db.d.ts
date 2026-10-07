import type { InventoryResult, InventoryStatus } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";
import type { RetailerCandidate } from "../discovery/types.js";
import type { AdapterCandidate, AdapterValidationReport } from "../generation/types.js";
import type { RetailerInspection } from "../inspection/types.js";
import type { NotificationPayload, PendingNotification } from "../notifications/types.js";
import type { InventoryWatch } from "../watches/types.js";
export type CreateWatchRecord = {
    id: string;
    productId: string;
    product: ProductIdentity;
    targets: Array<{
        id: string;
        domain: string;
        url: string;
        enabled: boolean;
    }>;
    enabled: boolean;
    createdAt: string;
};
export type InventoryDatabaseHealth = {
    schemaVersion: number;
    quickCheck: string[];
    healthy: boolean;
    fileSizeBytes: number | null;
    tableCounts: Record<string, number>;
};
export type AdapterApprovalRecord = {
    adapterId: string;
    domain: string;
    lifecycle: string;
    latestCandidateId?: string;
    activeCandidateId?: string;
    validationRuns: number;
    latestValidation?: {
        valid: boolean;
        promotable: boolean;
        validatedAt: string;
    };
    approvalEvents: Array<{
        action: "approved" | "revoked";
        candidateId: string;
        reason?: string;
        occurredAt: string;
    }>;
};
export declare class InventoryDatabase {
    #private;
    constructor(path: string);
    close(): void;
    schemaVersion(): number;
    healthStatus(): InventoryDatabaseHealth;
    migrate(): void;
    createWatch(record: CreateWatchRecord): InventoryWatch;
    getWatch(id: string): InventoryWatch | undefined;
    listWatches(): InventoryWatch[];
    removeWatch(id: string): boolean;
    latestStatus(targetId: string): InventoryStatus | undefined;
    recordObservation(input: {
        watchId: string;
        productId: string;
        targetId: string;
        result: InventoryResult;
        adapterId?: string;
        adapterVersion?: string;
        durationMs: number;
        previousStatus?: InventoryStatus;
        transitionChanged: boolean;
        notification?: {
            channel: string;
            target: string;
            accountId?: string;
            threadId?: string;
            payload: NotificationPayload;
        };
    }): number;
    claimNotifications(input: {
        now: string;
        limit: number;
        leaseMs: number;
    }): PendingNotification[];
    markNotificationSent(id: number, providerMessageId: string, sentAt: string, deliveryIntentId?: string): void;
    markNotificationHandedOff(id: number, input: {
        deliveryIntentId: string;
        error?: string;
        updatedAt: string;
    }): void;
    markNotificationSuppressed(id: number, input: {
        deliveryIntentId?: string;
        reason: string;
        updatedAt: string;
    }): void;
    markNotificationFailed(id: number, input: {
        error: string;
        terminal: boolean;
        nextAttemptAt: string;
        updatedAt: string;
    }): void;
    notificationStatus(): {
        pending: number;
        processing: number;
        handedOff: number;
        sent: number;
        suppressed: number;
        failed: number;
    };
    startMonitorRun(kind: "fast" | "slow", startedAt: string): number;
    completeMonitorRun(id: number, input: {
        completedAt: string;
        summary?: unknown;
        error?: string;
    }): void;
    monitorStatus(): Array<{
        kind: string;
        startedAt: string;
        completedAt?: string;
        status: string;
        summary?: unknown;
        error?: string;
    }>;
    saveRetailerCandidates(productId: string, candidates: RetailerCandidate[], discoveredAt: string): void;
    markWatchDiscovered(watchId: string, discoveredAt: string): void;
    recentStatuses(targetId: string, limit: number): InventoryStatus[];
    recordSlowInspection(watchId: string, targetId: string, inspection: RetailerInspection): void;
    saveAdapterCandidate(candidate: AdapterCandidate): void;
    getAdapterAudit(adapterId: string): {
        lifecycle: string;
        candidateId?: string;
        validationRuns: number;
    } | undefined;
    saveValidation(candidate: AdapterCandidate, report: AdapterValidationReport): void;
    getAdapterCandidate(candidateId: string): AdapterCandidate | undefined;
    listActiveAdapterCandidates(): AdapterCandidate[];
    listAdapterApprovals(adapterId?: string): AdapterApprovalRecord[];
    approveAdapterCandidate(input: {
        candidateId: string;
        sourceSha256: string;
        approvedAt: string;
        reason?: string;
    }): AdapterCandidate;
    revokeAdapterCandidate(input: {
        adapterId: string;
        candidateId: string;
        revokedAt: string;
        reason?: string;
    }): void;
    private hydrateWatch;
}
