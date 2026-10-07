import type { HttpFetch } from "../adapters/builtins/example-jsonld.js";
import type { InventoryResult } from "../domain/inventory.js";
import { createGeneratedJsonLdAdapter } from "./generated-jsonld-adapter.js";
import { validateCandidateSource } from "./policy.js";
import type {
  AdapterCandidate,
  AdapterFixture,
  AdapterLiveValidation,
  AdapterValidationReport,
  ValidationCheck,
} from "./types.js";

export async function validateRetailerAdapter(
  candidate: AdapterCandidate,
  testContext: {
    fixture?: AdapterFixture;
    live?: AdapterLiveValidation;
  },
  dependencies: { liveFetch?: HttpFetch; now?: () => Date } = {},
): Promise<AdapterValidationReport> {
  const checks: ValidationCheck[] = [];
  const errors: AdapterValidationReport["errors"] = [];
  const staticResult = validateCandidateSource(candidate);
  checks.push({
    name: "static",
    status: staticResult.passed ? "passed" : "failed",
    summary: staticResult.passed
      ? "Source matches the approved template, import allowlist, fingerprint, and syntax policy."
      : "Static source policy failed.",
  });
  errors.push(...staticResult.errors);

  if (!staticResult.passed) {
    for (const name of ["fixture", "live", "cross_check"] as const) {
      checks.push({ name, status: "skipped", summary: "Skipped because static validation failed." });
    }
    return report(candidate, checks, errors, dependencies.now);
  }

  const fixture = testContext.fixture;
  if (!fixture) {
    checks.push({ name: "fixture", status: "skipped", summary: "No sanitized fixture was supplied." });
    errors.push({ code: "FIXTURE_REQUIRED", message: "A sanitized fixture is required for validation." });
  } else {
    const fixtureFetch: HttpFetch = async () =>
      new Response(fixture.html, { status: fixture.httpStatus ?? 200 });
    const adapter = createGeneratedJsonLdAdapter(
      {
        id: candidate.spec.adapterId,
        version: candidate.spec.version,
        domains: [candidate.spec.domain],
      },
      fixtureFetch,
    );
    const result = await adapter.checkInventory(fixture.url, {
      expectedProduct: fixture.expectedProduct,
      timeoutMs: 2_000,
    });
    const expectedStatus = fixture.expectedStatus ?? candidate.basedOn.status;
    const passed = result.status === expectedStatus;
    checks.push({
      name: "fixture",
      status: passed ? "passed" : "failed",
      summary: passed
        ? `Fixture result agrees with ${expectedStatus}.`
        : `Fixture returned ${result.status}; expected ${expectedStatus}.`,
      result,
    });
    if (!passed) {
      errors.push({ code: "FIXTURE_MISMATCH", message: `Fixture returned ${result.status}.` });
    }
  }

  const live = testContext.live;
  let liveResult: InventoryResult | undefined;
  if (!live) {
    checks.push({ name: "live", status: "skipped", summary: "No live validation URL was supplied." });
    errors.push({ code: "LIVE_VALIDATION_REQUIRED", message: "Live validation is required before promotion." });
  } else {
    const adapter = createGeneratedJsonLdAdapter(
      {
        id: candidate.spec.adapterId,
        version: candidate.spec.version,
        domains: [candidate.spec.domain],
      },
      dependencies.liveFetch,
    );
    liveResult = await adapter.checkInventory(live.url, {
      expectedProduct: live.expectedProduct,
      timeoutMs: live.timeoutMs ?? 10_000,
      signal: live.signal,
    });
    const passed = !["unknown", "blocked", "error"].includes(liveResult.status);
    checks.push({
      name: "live",
      status: passed ? "passed" : "failed",
      summary: passed
        ? `Live deterministic check returned ${liveResult.status}.`
        : `Live deterministic check was not conclusive: ${liveResult.status}.`,
      result: liveResult,
    });
    if (!passed) {
      errors.push({ code: "LIVE_VALIDATION_FAILED", message: `Live check returned ${liveResult.status}.` });
    }
  }

  if (!live || !liveResult) {
    checks.push({
      name: "cross_check",
      status: "skipped",
      summary: "A live deterministic result and inspection observation are required.",
    });
  } else {
    const passed =
      liveResult.status === live.observedStatus &&
      liveResult.confidence >= 0.9 &&
      live.observationConfidence >= 0.9;
    checks.push({
      name: "cross_check",
      status: passed ? "passed" : "failed",
      summary: passed
        ? `Deterministic and inspection results agree on ${live.observedStatus} at high confidence.`
        : `Deterministic result ${liveResult.status} does not confidently agree with observed ${live.observedStatus}.`,
      result: liveResult,
    });
    if (!passed) {
      errors.push({
        code: "CROSS_CHECK_MISMATCH",
        message: "Live deterministic output did not match the high-confidence inspection.",
      });
    }
  }

  return report(candidate, checks, errors, dependencies.now);
}

function report(
  candidate: AdapterCandidate,
  checks: ValidationCheck[],
  errors: AdapterValidationReport["errors"],
  now?: () => Date,
): AdapterValidationReport {
  const valid =
    errors.length === 0 && checks.length === 4 && checks.every(({ status }) => status === "passed");
  return {
    candidateId: candidate.candidateId,
    lifecycle: valid ? "validated" : "candidate",
    valid,
    promotable: valid,
    approvalRequired: true,
    validatedAt: (now?.() ?? new Date()).toISOString(),
    checks,
    errors,
  };
}
