import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../adapters/registry.js";
import { generateRetailerAdapter } from "../generation/generate-adapter.js";
import { validateRetailerAdapter } from "../generation/validate-adapter.js";
import { WatchService } from "../watches/service.js";
import { InventoryDatabase } from "./db.js";

const fixture = `<script type="application/ld+json">{
  "@type":"Product",
  "sku":"DB-42",
  "offers":{"@type":"Offer","availability":"https://schema.org/InStock"}
}</script>`;

describe("InventoryDatabase persistence", () => {
  it("migrates a legacy notification table to schema version 6", () => {
    const directory = mkdtempSync(join(tmpdir(), "inventorybot-migration-"));
    const path = join(directory, "inventorybot.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        observation_id INTEGER,
        channel TEXT NOT NULL,
        transition TEXT NOT NULL,
        sent_at TEXT,
        payload_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new InventoryDatabase(path);
    try {
      expect(migrated.schemaVersion()).toBe(6);
      expect(migrated.notificationStatus()).toEqual({
        pending: 0,
        processing: 0,
        handedOff: 0,
        sent: 0,
        suppressed: 0,
        failed: 0,
      });
    } finally {
      migrated.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports integrity, file size, and table counts", () => {
    const directory = mkdtempSync(join(tmpdir(), "inventorybot-health-"));
    const path = join(directory, "inventorybot.sqlite");
    const database = new InventoryDatabase(path);
    try {
      new WatchService(database, new AdapterRegistry()).add({
        product: { sku: "HEALTH-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      });
      expect(database.healthStatus()).toMatchObject({
        schemaVersion: 6,
        quickCheck: ["ok"],
        healthy: true,
        tableCounts: {
          products: 1,
          inventory_watches: 1,
          inventory_targets: 1,
        },
      });
      expect(database.healthStatus().fileSizeBytes).toBeGreaterThan(0);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a symlink as the database destination", () => {
    const directory = mkdtempSync(join(tmpdir(), "inventorybot-symlink-"));
    const target = join(directory, "target.sqlite");
    const link = join(directory, "inventorybot.sqlite");
    writeFileSync(target, "not a database");
    symlinkSync(target, link);
    try {
      expect(() => new InventoryDatabase(link)).toThrow("regular file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains watches after the database is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "inventorybot-test-"));
    const path = join(directory, "inventorybot.sqlite");
    let watchId: string;
    const first = new InventoryDatabase(path);
    try {
      watchId = new WatchService(first, new AdapterRegistry()).add({
        product: { sku: "PERSIST-42" },
        retailers: [{ url: "https://shop.example.test/products/42" }],
      }).id;
    } finally {
      first.close();
    }

    const reopened = new InventoryDatabase(path);
    try {
      expect(reopened.getWatch(watchId!)).toMatchObject({
        id: watchId!,
        product: { sku: "PERSIST-42" },
      });
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("handles a moderate watch inventory", () => {
    const database = new InventoryDatabase(":memory:");
    const service = new WatchService(database, new AdapterRegistry());
    try {
      for (let index = 0; index < 500; index += 1) {
        service.add({
          product: { sku: `SCALE-${index}` },
          retailers: [{ url: `https://shop.example.test/products/${index}` }],
        });
      }
      const startedAt = performance.now();
      const watches = database.listWatches();
      const elapsedMs = performance.now() - startedAt;
      expect(watches).toHaveLength(500);
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      database.close();
    }
  }, 15_000);

  it("persists candidates and validation history without activating them", async () => {
    const generated = generateRetailerAdapter("shop.example.com", [{
      url: "https://shop.example.com/products/42",
      status: "in_stock",
      confidence: 0.98,
      method: "json_ld",
      productMatchConfidence: 1,
      evidenceSummary: "JSON-LD says in stock.",
    }]);
    if (!generated.generated) throw new Error(generated.error.message);
    const candidate = generated.candidate;
    const report = await validateRetailerAdapter(
      candidate,
      {
        fixture: {
          url: candidate.basedOn.url,
          html: fixture,
          expectedProduct: { sku: "DB-42" },
          expectedStatus: "in_stock",
        },
        live: {
          url: candidate.basedOn.url,
          expectedProduct: { sku: "DB-42" },
          observedStatus: "in_stock",
          observationConfidence: 0.98,
        },
      },
      { liveFetch: vi.fn(async () => new Response(fixture)) },
    );

    const database = new InventoryDatabase(":memory:");
    try {
      database.saveAdapterCandidate(candidate);
      expect(database.getAdapterAudit(candidate.spec.adapterId)).toMatchObject({
        lifecycle: "candidate",
        candidateId: candidate.candidateId,
        validationRuns: 0,
      });
      database.saveValidation(candidate, report);
      expect(database.getAdapterAudit(candidate.spec.adapterId)).toMatchObject({
        lifecycle: "validated",
        candidateId: candidate.candidateId,
        validationRuns: 1,
      });
    } finally {
      database.close();
    }
  });
});
