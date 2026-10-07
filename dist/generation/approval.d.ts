import { AdapterRegistry } from "../adapters/registry.js";
import type { RetailerAdapter } from "../adapters/types.js";
import type { InventoryDatabase } from "../persistence/db.js";
import type { AdapterCandidate } from "./types.js";
export type AdapterApprovalResult = {
    approved: true;
    adapterId: string;
    candidateId: string;
    sourceSha256: string;
    domain: string;
    version: string;
    lifecycle: "active";
    approvedAt: string;
} | {
    approved: false;
    error: {
        code: string;
        message: string;
    };
};
export declare function approveRetailerAdapter(database: InventoryDatabase, input: {
    candidateId: string;
    sourceSha256: string;
    confirmActivation: true;
    reason?: string;
}, now?: () => Date): AdapterApprovalResult;
export declare function revokeRetailerAdapter(database: InventoryDatabase, input: {
    adapterId: string;
    candidateId: string;
    confirmRevocation: true;
    reason?: string;
}, now?: () => Date): {
    revoked: true;
    adapterId: string;
    candidateId: string;
    lifecycle: "disabled";
    revokedAt: string;
} | {
    revoked: false;
    error: {
        code: string;
        message: string;
    };
};
export declare function createActiveAdapterRegistry(database: InventoryDatabase, options?: {
    authoredAdapters?: RetailerAdapter[];
    onRejectedCandidate?: (candidate: AdapterCandidate, errors: string[]) => void;
}): AdapterRegistry;
