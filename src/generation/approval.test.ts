import { describe, expect, it } from "vitest";
import { InventoryDatabase } from "../persistence/db.js";
import {
  approveRetailerAdapter,
  createActiveAdapterRegistry,
  revokeRetailerAdapter,
} from "./approval.js";
import { generateRetailerAdapter } from "./generate-adapter.js";
import type { AdapterCandidate } from "./types.js";
import { validateRetailerAdapter } from "./validate-adapter.js";

const fixture = `<script type="application/ld+json">{
  "@type":"Product",
  "sku":"APPROVE-42",
  "offers":{"@type":"Offer","availability":"https://schema.org/InStock"}
}</script>`;

function candidate(): AdapterCandidate {
  const result = generateRetailerAdapter("shop.example.com", [{
    url: "https://shop.example.com/products/42",
    status: "in_stock",
    confidence: 0.99,
    method: "json_ld",
    productMatchConfidence: 1,
    evidenceSummary: "Conclusive JSON-LD.",
  }], { now: () => new Date("2026-01-01T00:00:00.000Z") });
  if (!result.generated) throw new Error(result.error.message);
  return result.candidate;
}

async function validate(database: InventoryDatabase, adapterCandidate: AdapterCandidate) {
  const report = await validateRetailerAdapter(adapterCandidate, {
    fixture: {
      url: adapterCandidate.basedOn.url,
      html: fixture,
      expectedProduct: { sku: "APPROVE-42" },
      expectedStatus: "in_stock",
    },
    live: {
      url: adapterCandidate.basedOn.url,
      expectedProduct: { sku: "APPROVE-42" },
      observedStatus: "in_stock",
      observationConfidence: 0.99,
    },
  }, { liveFetch: async () => new Response(fixture) });
  expect(report.promotable).toBe(true);
  database.saveValidation(adapterCandidate, report);
}

describe("adapter approval", () => {
  it("refuses unvalidated candidates and mismatched source fingerprints", async () => {
    const database = new InventoryDatabase(":memory:");
    const adapterCandidate = candidate();
    try {
      database.saveAdapterCandidate(adapterCandidate);
      expect(approveRetailerAdapter(database, {
        candidateId: adapterCandidate.candidateId,
        sourceSha256: adapterCandidate.sourceSha256,
        confirmActivation: true,
      })).toMatchObject({ approved: false, error: { code: "ADAPTER_NOT_PROMOTABLE" } });

      await validate(database, adapterCandidate);
      expect(approveRetailerAdapter(database, {
        candidateId: adapterCandidate.candidateId,
        sourceSha256: "0".repeat(64),
        confirmActivation: true,
      })).toMatchObject({ approved: false, error: { code: "ADAPTER_SOURCE_HASH_MISMATCH" } });
    } finally {
      database.close();
    }
  });

  it("rechecks static policy even when persisted validation claims promotion", () => {
    const database = new InventoryDatabase(":memory:");
    const original = candidate();
    const tampered = { ...original, source: `${original.source}\n// changed after validation` };
    try {
      database.saveValidation(tampered, {
        candidateId: tampered.candidateId,
        lifecycle: "validated",
        valid: true,
        promotable: true,
        approvalRequired: true,
        validatedAt: "2026-01-02T00:00:00.000Z",
        checks: [],
        errors: [],
      });
      expect(approveRetailerAdapter(database, {
        candidateId: tampered.candidateId,
        sourceSha256: tampered.sourceSha256,
        confirmActivation: true,
      })).toMatchObject({
        approved: false,
        error: { code: "ADAPTER_STATIC_POLICY_FAILED" },
      });
      expect(database.listActiveAdapterCandidates()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("activates an exact validated version and preserves immutable audit history", async () => {
    const database = new InventoryDatabase(":memory:");
    const first = candidate();
    try {
      await validate(database, first);
      expect(approveRetailerAdapter(database, {
        candidateId: first.candidateId,
        sourceSha256: first.sourceSha256,
        confirmActivation: true,
        reason: "Operator reviewed validation evidence.",
      }, () => new Date("2026-01-02T00:00:00.000Z"))).toMatchObject({
        approved: true,
        candidateId: first.candidateId,
        lifecycle: "active",
      });
      expect(createActiveAdapterRegistry(database, { authoredAdapters: [] }).get(first.basedOn.url))
        .toMatchObject({ id: first.spec.adapterId, version: "1.0.0" });

      database.saveAdapterCandidate(first);
      expect(database.listAdapterApprovals(first.spec.adapterId)[0]).toMatchObject({
        lifecycle: "active",
        activeCandidateId: first.candidateId,
        latestCandidateId: first.candidateId,
        approvalEvents: [{ action: "approved", candidateId: first.candidateId }],
      });
    } finally {
      database.close();
    }
  });

  it("revokes only the exact active version", async () => {
    const database = new InventoryDatabase(":memory:");
    const adapterCandidate = candidate();
    try {
      await validate(database, adapterCandidate);
      approveRetailerAdapter(database, {
        candidateId: adapterCandidate.candidateId,
        sourceSha256: adapterCandidate.sourceSha256,
        confirmActivation: true,
      });
      expect(revokeRetailerAdapter(database, {
        adapterId: adapterCandidate.spec.adapterId,
        candidateId: "wrong-version",
        confirmRevocation: true,
      })).toMatchObject({ revoked: false, error: { code: "ADAPTER_ACTIVE_VERSION_MISMATCH" } });
      expect(revokeRetailerAdapter(database, {
        adapterId: adapterCandidate.spec.adapterId,
        candidateId: adapterCandidate.candidateId,
        confirmRevocation: true,
        reason: "Retailer changed markup.",
      })).toMatchObject({ revoked: true, lifecycle: "disabled" });
      expect(createActiveAdapterRegistry(database, { authoredAdapters: [] }).get(adapterCandidate.basedOn.url))
        .toBeUndefined();
      const audit = database.listAdapterApprovals(adapterCandidate.spec.adapterId)[0];
      expect(audit).toMatchObject({ lifecycle: "disabled" });
      expect(audit.approvalEvents[0]).toMatchObject({
        action: "revoked",
        reason: "Retailer changed markup.",
      });
    } finally {
      database.close();
    }
  });
});
