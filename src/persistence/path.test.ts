import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInventoryDatabasePath } from "./path.js";

describe("resolveInventoryDatabasePath", () => {
  const stateDir = resolve("/tmp/openclaw-state");

  it("places the default and relative paths beneath the state directory", () => {
    expect(resolveInventoryDatabasePath(stateDir)).toBe(
      resolve(stateDir, "plugins/inventorybot/inventorybot.sqlite"),
    );
    expect(resolveInventoryDatabasePath(stateDir, "custom/inventory.sqlite")).toBe(
      resolve(stateDir, "custom/inventory.sqlite"),
    );
  });

  it("rejects relative traversal outside the state directory", () => {
    expect(() => resolveInventoryDatabasePath(stateDir, "../inventory.sqlite")).toThrow(
      "must remain within",
    );
  });

  it("allows explicit absolute paths and the in-memory database", () => {
    expect(resolveInventoryDatabasePath(stateDir, "/var/lib/inventorybot.sqlite")).toBe(
      resolve("/var/lib/inventorybot.sqlite"),
    );
    expect(resolveInventoryDatabasePath(stateDir, ":memory:")).toBe(":memory:");
  });
});
