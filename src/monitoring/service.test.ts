import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../adapters/registry.js";
import type { RetailerAdapter } from "../adapters/types.js";
import { normalizeInventoryResult } from "../domain/inventory.js";
import type { AdapterCandidate } from "../generation/types.js";
import { InventoryDatabase } from "../persistence/db.js";
import { WatchService } from "../watches/service.js";
import { parseInventoryBotConfig } from "./config.js";
import { InventoryMonitor } from "./service.js";

class BlockingAdapter implements RetailerAdapter {
  readonly id = "blocking";
  readonly version = "1.0.0";
  readonly domains = ["shop.example.test"];

  constructor(private readonly started: () => void) {}

  canHandle(url: string): boolean {
    return new URL(url).hostname === "shop.example.test";
  }

  async checkInventory(_url: string, context?: { signal?: AbortSignal }): Promise<never> {
    this.started();
    return await new Promise<never>((_resolve, reject) => {
      const signal = context?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

class StatusAdapter implements RetailerAdapter {
  readonly id = "status";
  readonly version = "1.0.0";
  readonly domains = ["shop.example.test"];
  canHandle(url: string): boolean {
    return new URL(url).hostname === "shop.example.test";
  }
  async checkInventory(url: string) {
    return normalizeInventoryResult({
      status: "unknown",
      confidence: 0.5,
      method: "html",
      domain: "shop.example.test",
      url,
      checkedAt: "2026-01-01T00:00:00.000Z",
      evidence: { summary: "Ambiguous fixture." },
    });
  }
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "inventorybot-monitor-"));
  const path = join(directory, "inventorybot.sqlite");
  return { directory, path, open: () => new InventoryDatabase(path) };
}

describe("InventoryMonitor", () => {
  it("runs every enabled watch through the deterministic fast loop", async () => {
    const temporary = temporaryDatabase();
    const registry = new AdapterRegistry([new StatusAdapter()]);
    const seed = temporary.open();
    try {
      new WatchService(seed, registry).add({
        product: { sku: "MON-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
    } finally {
      seed.close();
    }

    const monitor = new InventoryMonitor({
      databaseFactory: temporary.open,
      registry,
      config: parseInventoryBotConfig({ monitoring: { maxConcurrency: 2 } }),
    });
    try {
      const result = await monitor.runFast();
      expect(result).toMatchObject({
        watches: 1,
        checkedTargets: 1,
        watchFailures: 0,
      });
      const database = temporary.open();
      try {
        expect(database.monitorStatus()).toMatchObject([
          { kind: "fast", status: "completed" },
        ]);
      } finally {
        database.close();
      }
    } finally {
      await monitor.stop();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("aborts an active run on shutdown and permits a clean reopen", async () => {
    const temporary = temporaryDatabase();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const registry = new AdapterRegistry([new BlockingAdapter(() => notifyStarted?.())]);
    const seed = temporary.open();
    try {
      new WatchService(seed, registry).add({
        product: { sku: "STOP-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
    } finally {
      seed.close();
    }

    const monitor = new InventoryMonitor({
      databaseFactory: temporary.open,
      registry,
      config: parseInventoryBotConfig({ monitoring: { enabled: true } }),
    });
    monitor.start();
    const outcome = monitor.runFast().then(
      () => "completed" as const,
      () => "aborted" as const,
    );
    await started;
    await monitor.stop();
    expect(await outcome).toBe("aborted");

    const reopened = temporary.open();
    try {
      expect(reopened.healthStatus()).toMatchObject({ healthy: true, quickCheck: ["ok"] });
      expect(reopened.monitorStatus()).toMatchObject([{ kind: "fast", status: "error" }]);
    } finally {
      reopened.close();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });

  it("discovers stale retailers and inspects repeatedly uncertain targets", async () => {
    const temporary = temporaryDatabase();
    const registry = new AdapterRegistry([new StatusAdapter()]);
    const seed = temporary.open();
    try {
      const watch = new WatchService(seed, registry).add({
        product: { name: "Monitor Product", sku: "MON-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
      await new WatchService(seed, registry).run(watch.id);
    } finally {
      seed.close();
    }

    const inspect = vi.fn(async (url: string) => ({
      level: "static" as const,
      finalUrl: url,
      product: { sku: "MON-42" },
      inventory: normalizeInventoryResult({
        status: "in_stock",
        confidence: 0.99,
        method: "json_ld",
        domain: "shop.example.test",
        url,
        checkedAt: "2026-01-02T00:00:00.000Z",
        evidence: { summary: "Conclusive JSON-LD fixture." },
      }),
      observations: [],
      sanitizedFixture: { kind: "json_ld" as const, html: "<script></script>", sha256: "a".repeat(64) },
      nextRecommendedLevel: "none" as const,
    }));
    const validate = vi.fn(async (candidate: AdapterCandidate) => ({
      candidateId: candidate.candidateId,
      lifecycle: "validated" as const,
      valid: true,
      promotable: true,
      approvalRequired: true as const,
      validatedAt: "2026-01-02T00:00:00.000Z",
      checks: [],
      errors: [],
    }));
    const monitor = new InventoryMonitor({
      databaseFactory: temporary.open,
      registry,
      config: parseInventoryBotConfig({
        monitoring: { inspectAfterUnknownCount: 1, rediscoveryAfterHours: 1 },
      }),
      searchClient: {
        search: vi.fn(async () => [{
          url: "https://new-shop.example/products/mon-42",
          title: "Monitor Product MON-42",
        }]),
      },
      inspect,
      validate,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    try {
      const result = await monitor.runSlow();
      expect(result).toMatchObject({
        watchesConsidered: 1,
        discoveries: 1,
        candidatesFound: 1,
        targetsInspected: 1,
        adapterCandidatesGenerated: 1,
        adapterCandidatesValidated: 1,
        failures: 0,
      });
      expect(inspect).toHaveBeenCalledOnce();
      expect(validate).toHaveBeenCalledOnce();
    } finally {
      await monitor.stop();
      rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});
