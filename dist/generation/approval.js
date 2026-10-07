import { ExampleJsonLdAdapter } from "../adapters/builtins/example-jsonld.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { createGeneratedJsonLdAdapter } from "./generated-jsonld-adapter.js";
import { validateCandidateSource } from "./policy.js";
function errorResult(code, message) {
    return { approved: false, error: { code, message } };
}
function staticPolicyError(candidate) {
    const policy = validateCandidateSource(candidate);
    if (policy.passed)
        return undefined;
    return errorResult("ADAPTER_STATIC_POLICY_FAILED", `Candidate no longer satisfies static policy: ${policy.errors.map(({ code }) => code).join(", ")}`);
}
export function approveRetailerAdapter(database, input, now = () => new Date()) {
    if (input.confirmActivation !== true) {
        return errorResult("ADAPTER_APPROVAL_CONFIRMATION_REQUIRED", "Explicit activation confirmation is required.");
    }
    const candidate = database.getAdapterCandidate(input.candidateId);
    if (!candidate)
        return errorResult("ADAPTER_CANDIDATE_NOT_FOUND", "Adapter candidate was not found.");
    if (candidate.sourceSha256 !== input.sourceSha256) {
        return errorResult("ADAPTER_SOURCE_HASH_MISMATCH", "The supplied source hash does not match the candidate.");
    }
    const policyError = staticPolicyError(candidate);
    if (policyError)
        return policyError;
    const approvedAt = now().toISOString();
    try {
        const approved = database.approveAdapterCandidate({
            candidateId: input.candidateId,
            sourceSha256: input.sourceSha256,
            approvedAt,
            reason: input.reason,
        });
        return {
            approved: true,
            adapterId: approved.spec.adapterId,
            candidateId: approved.candidateId,
            sourceSha256: approved.sourceSha256,
            domain: approved.spec.domain,
            version: approved.spec.version,
            lifecycle: "active",
            approvedAt,
        };
    }
    catch (error) {
        const code = error instanceof Error ? error.message : "ADAPTER_APPROVAL_FAILED";
        const messages = {
            ADAPTER_CANDIDATE_NOT_FOUND: "Adapter candidate was not found.",
            ADAPTER_SOURCE_HASH_MISMATCH: "The stored source hash changed before approval.",
            ADAPTER_NOT_PROMOTABLE: "The latest validation is not valid and promotable.",
        };
        return errorResult(code, messages[code] ?? "Adapter approval failed.");
    }
}
export function revokeRetailerAdapter(database, input, now = () => new Date()) {
    if (input.confirmRevocation !== true) {
        return {
            revoked: false,
            error: { code: "ADAPTER_REVOCATION_CONFIRMATION_REQUIRED", message: "Explicit revocation confirmation is required." },
        };
    }
    const revokedAt = now().toISOString();
    try {
        database.revokeAdapterCandidate({ ...input, revokedAt });
        return {
            revoked: true,
            adapterId: input.adapterId,
            candidateId: input.candidateId,
            lifecycle: "disabled",
            revokedAt,
        };
    }
    catch (error) {
        const code = error instanceof Error ? error.message : "ADAPTER_REVOCATION_FAILED";
        const messages = {
            ADAPTER_NOT_FOUND: "Adapter was not found.",
            ADAPTER_ACTIVE_VERSION_MISMATCH: "The supplied candidate is not the active adapter version.",
        };
        return { revoked: false, error: { code, message: messages[code] ?? "Adapter revocation failed." } };
    }
}
export function createActiveAdapterRegistry(database, options = {}) {
    const registry = new AdapterRegistry(options.authoredAdapters ?? [new ExampleJsonLdAdapter()]);
    for (const candidate of database.listActiveAdapterCandidates()) {
        const policy = validateCandidateSource(candidate);
        if (!policy.passed) {
            options.onRejectedCandidate?.(candidate, policy.errors.map(({ code }) => code));
            continue;
        }
        registry.register(createGeneratedJsonLdAdapter({
            id: candidate.spec.adapterId,
            version: candidate.spec.version,
            domains: [candidate.spec.domain],
        }));
    }
    return registry;
}
