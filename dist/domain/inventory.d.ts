export type InventoryStatus = "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown" | "blocked" | "error";
export type InventoryMethod = "json_ld" | "embedded_json" | "public_api" | "html" | "network_api" | "browser" | "unknown";
export type InventoryResult = {
    status: InventoryStatus;
    confidence: number;
    domain: string;
    url: string;
    productMatchConfidence?: number;
    price?: number;
    currency?: string;
    sku?: string;
    seller?: string;
    method: InventoryMethod;
    checkedAt: string;
    evidence: {
        summary: string;
        raw?: Record<string, unknown>;
    };
    error?: {
        code: string;
        message: string;
    };
};
export type InventoryResultInput = Omit<InventoryResult, "confidence" | "checkedAt"> & {
    confidence: number;
    checkedAt?: string;
};
export declare function normalizeInventoryResult(result: InventoryResultInput): InventoryResult;
