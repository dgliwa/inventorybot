import type { InventoryStatus, InventoryMethod, InventoryResult } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";

export type AdapterLifecycle =
  | "candidate"
  | "validated"
  | "approved"
  | "active"
  | "degraded"
  | "disabled";

export type AdapterGenerationObservation = {
  url: string;
  status: InventoryStatus;
  confidence: number;
  method: InventoryMethod;
  productMatchConfidence?: number;
  evidenceSummary: string;
};

export type GeneratedAdapterSpec = {
  adapterId: string;
  version: string;
  domain: string;
  strategy: "json_ld";
};

export type AdapterCandidate = {
  candidateId: string;
  lifecycle: "candidate";
  generatedAt: string;
  generationReason: "unsupported_retailer" | "repair";
  spec: GeneratedAdapterSpec;
  source: string;
  sourceSha256: string;
  basedOn: AdapterGenerationObservation;
  requiresApproval: true;
};

export type AdapterGenerationResult =
  | { generated: true; candidate: AdapterCandidate }
  | {
      generated: false;
      error: { code: string; message: string };
    };

export type AdapterFixture = {
  url: string;
  html: string;
  expectedProduct?: ProductIdentity;
  expectedStatus?: InventoryStatus;
  httpStatus?: number;
};

export type AdapterLiveValidation = {
  url: string;
  expectedProduct?: ProductIdentity;
  observedStatus: InventoryStatus;
  observationConfidence: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ValidationCheck = {
  name: "static" | "fixture" | "live" | "cross_check";
  status: "passed" | "failed" | "skipped";
  summary: string;
  result?: InventoryResult;
};

export type AdapterValidationReport = {
  candidateId: string;
  lifecycle: "candidate" | "validated";
  valid: boolean;
  promotable: boolean;
  approvalRequired: true;
  validatedAt: string;
  checks: ValidationCheck[];
  errors: Array<{ code: string; message: string }>;
};
