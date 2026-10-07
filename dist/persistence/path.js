import { isAbsolute, relative, resolve } from "node:path";
function isWithin(parent, child) {
    const relation = relative(parent, child);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}
export function resolveInventoryDatabasePath(stateDir, configuredPath) {
    const resolvedStateDir = resolve(stateDir);
    if (!configuredPath) {
        return resolve(resolvedStateDir, "plugins", "inventorybot", "inventorybot.sqlite");
    }
    if (configuredPath === ":memory:")
        return configuredPath;
    if (configuredPath.includes("\0"))
        throw new Error("Database path cannot contain null bytes.");
    if (isAbsolute(configuredPath))
        return resolve(configuredPath);
    const resolvedPath = resolve(resolvedStateDir, configuredPath);
    if (!isWithin(resolvedStateDir, resolvedPath)) {
        throw new Error("Relative database path must remain within the OpenClaw state directory.");
    }
    return resolvedPath;
}
