export function normalizeInventoryResult(result) {
    return {
        ...result,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        checkedAt: result.checkedAt ?? new Date().toISOString(),
    };
}
