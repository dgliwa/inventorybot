import { normalizeInventoryResult } from "../domain/inventory.js";
import { normalizeDomain } from "../adapters/url.js";
function invalidUrlResult(url, error) {
    return normalizeInventoryResult({
        status: "error",
        confidence: 1,
        domain: "",
        url,
        method: "unknown",
        evidence: { summary: "The supplied product URL is invalid." },
        error: {
            code: "INVALID_URL",
            message: error instanceof Error ? error.message : String(error),
        },
    });
}
export async function checkInventory(input, registry) {
    let domain;
    try {
        domain = normalizeDomain(input.url);
    }
    catch (error) {
        return invalidUrlResult(input.url, error);
    }
    const adapter = registry.get(input.url);
    if (!adapter) {
        return normalizeInventoryResult({
            status: "unknown",
            confidence: 1,
            domain,
            url: input.url,
            method: "unknown",
            evidence: { summary: `No active adapter is registered for ${domain}.` },
            error: {
                code: "UNSUPPORTED_RETAILER",
                message: `InventoryBot does not have an active adapter for ${domain}.`,
            },
        });
    }
    const context = {
        expectedProduct: input.expectedProduct,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
    };
    return adapter.checkInventory(input.url, context);
}
