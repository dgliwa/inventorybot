import { describe, expect, it, vi } from "vitest";
import { generateRetailerAdapter, renderAdapterSource } from "./generate-adapter.js";
import { validateCandidateSource } from "./policy.js";
import { validateRetailerAdapter } from "./validate-adapter.js";
import type { AdapterCandidate, AdapterGenerationObservation } from "./types.js";

const page = (availability = "https://schema.org/InStock") => `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Generated Adapter Product",
  "sku": "GEN-42",
  "offers": {
    "@type": "Offer",
    "availability": "${availability}",
    "price": "42.00",
    "priceCurrency": "USD"
  }
}
</script>`;

const observation: AdapterGenerationObservation = {
  url: "https://shop.example.com/products/42",
  status: "in_stock",
  confidence: 0.98,
  method: "json_ld",
  productMatchConfidence: 1,
  evidenceSummary: "schema.org availability maps to in_stock.",
};

function candidate(): AdapterCandidate {
  const result = generateRetailerAdapter("shop.example.com", [observation], {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  if (!result.generated) throw new Error(result.error.message);
  return result.candidate;
}

describe("generateRetailerAdapter", () => {
  it("creates an immutable candidate from a high-confidence JSON-LD observation", () => {
    expect(candidate()).toMatchObject({
      lifecycle: "candidate",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generationReason: "unsupported_retailer",
      spec: {
        adapterId: "generated-shop-example-com-jsonld",
        version: "1.0.0",
        domain: "shop.example.com",
        strategy: "json_ld",
      },
      requiresApproval: true,
    });
    expect(candidate().source).toBe(renderAdapterSource(candidate().spec));
    expect(candidate().sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["HTML observation", "shop.example.com", [{ ...observation, method: "html" }]],
    ["low confidence", "shop.example.com", [{ ...observation, confidence: 0.5 }]],
    ["unknown status", "shop.example.com", [{ ...observation, status: "unknown" }]],
    ["other domain", "other.example.com", [observation]],
    ["private domain", "localhost", [observation]],
  ])("rejects %s", (_name, domain, observations) => {
    expect(generateRetailerAdapter(domain, observations as AdapterGenerationObservation[])).toMatchObject({
      generated: false,
    });
  });
});

describe("candidate source policy", () => {
  it("accepts only the exact approved template", () => {
    expect(validateCandidateSource(candidate())).toEqual({ passed: true, errors: [] });
  });

  it("rejects source mutation and forbidden APIs", () => {
    const tampered = {
      ...candidate(),
      source: `${candidate().source}\nrequire("node:child_process").exec("whoami");`,
    };
    const result = validateCandidateSource(tampered);
    expect(result.passed).toBe(false);
    expect(result.errors.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["SOURCE_HASH_MISMATCH", "SOURCE_TEMPLATE_MISMATCH", "FORBIDDEN_API"]),
    );
  });
});

describe("validateRetailerAdapter", () => {
  it("passes static, fixture, live, and cross-check validation without promotion", async () => {
    const report = await validateRetailerAdapter(
      candidate(),
      {
        fixture: {
          url: observation.url,
          html: page(),
          expectedProduct: { sku: "GEN-42" },
          expectedStatus: "in_stock",
        },
        live: {
          url: observation.url,
          expectedProduct: { sku: "GEN-42" },
          observedStatus: "in_stock",
          observationConfidence: 0.98,
        },
      },
      {
        liveFetch: vi.fn(async () => new Response(page(), { status: 200 })),
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      },
    );

    expect(report).toMatchObject({
      lifecycle: "validated",
      valid: true,
      promotable: true,
      approvalRequired: true,
      validatedAt: "2026-01-02T00:00:00.000Z",
      errors: [],
    });
    expect(report.checks.map(({ status }) => status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
  });

  it("remains a candidate when live validation is absent", async () => {
    const report = await validateRetailerAdapter(candidate(), {
      fixture: { url: observation.url, html: page(), expectedStatus: "in_stock" },
    });
    expect(report).toMatchObject({
      lifecycle: "candidate",
      valid: false,
      promotable: false,
      approvalRequired: true,
    });
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "LIVE_VALIDATION_REQUIRED" }));
  });

  it("fails a disagreement between deterministic and inspection results", async () => {
    const report = await validateRetailerAdapter(
      candidate(),
      {
        fixture: { url: observation.url, html: page(), expectedStatus: "in_stock" },
        live: {
          url: observation.url,
          observedStatus: "out_of_stock",
          observationConfidence: 0.99,
        },
      },
      { liveFetch: vi.fn(async () => new Response(page(), { status: 200 })) },
    );
    expect(report.promotable).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({ code: "CROSS_CHECK_MISMATCH" }));
  });

  it("does not execute a source-tampered candidate", async () => {
    const tampered = { ...candidate(), source: `${candidate().source}\neval("bad")` };
    const liveFetch = vi.fn(async () => new Response(page(), { status: 200 }));
    const report = await validateRetailerAdapter(
      tampered,
      {
        fixture: { url: observation.url, html: page() },
        live: {
          url: observation.url,
          observedStatus: "in_stock",
          observationConfidence: 0.99,
        },
      },
      { liveFetch },
    );
    expect(report.checks[0].status).toBe("failed");
    expect(liveFetch).not.toHaveBeenCalled();
  });
});
