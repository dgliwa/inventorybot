export function detectInventoryTransition(previousStatus, currentStatus, options = {}) {
    const changed = previousStatus !== currentStatus;
    const becameAvailable = currentStatus === "in_stock" && previousStatus !== "in_stock";
    const becameUnavailable = options.notifyWhenUnavailable === true &&
        previousStatus === "in_stock" &&
        currentStatus === "out_of_stock";
    return {
        previousStatus,
        currentStatus,
        changed,
        notifyRecommended: changed && (becameAvailable || becameUnavailable),
    };
}
