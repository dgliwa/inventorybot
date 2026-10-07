import { createHash } from "node:crypto";
import * as ts from "typescript";
import { domainMatches, normalizeDomain } from "../adapters/url.js";
import { normalizeAdapterDomain, renderAdapterSource } from "./generate-adapter.js";
const APPROVED_IMPORT = "../../src/generation/generated-jsonld-adapter.js";
const FORBIDDEN_SOURCE_PATTERNS = [
    [/\b(?:child_process|worker_threads|node:vm|node:fs|node:process)\b/, "forbidden Node.js API"],
    [/\b(?:eval|Function)\s*\(/, "dynamic code execution"],
    [/\b(?:spawn|exec|fork)\s*\(/, "process execution"],
    [/\b(?:writeFile|appendFile|rm|unlink|mkdir)\s*\(/, "filesystem mutation"],
    [/\b(?:POST|PUT|PATCH|DELETE)\b/, "non-read-only HTTP method"],
];
export function validateCandidateSource(candidate) {
    const errors = [];
    const actualHash = createHash("sha256").update(candidate.source).digest("hex");
    const normalizedDomain = normalizeAdapterDomain(candidate.spec.domain);
    const expectedAdapterId = normalizedDomain
        ? `generated-${normalizedDomain.replace(/[^a-z0-9]+/g, "-")}-jsonld`
        : "";
    if (normalizedDomain !== candidate.spec.domain ||
        candidate.spec.adapterId !== expectedAdapterId ||
        candidate.spec.version !== "1.0.0" ||
        candidate.spec.strategy !== "json_ld") {
        errors.push({
            code: "INVALID_SPEC",
            message: "Candidate spec is outside the approved JSON-LD template contract.",
        });
    }
    try {
        if (!domainMatches(normalizeDomain(candidate.basedOn.url), candidate.spec.domain) ||
            candidate.basedOn.method !== "json_ld" ||
            candidate.basedOn.confidence < 0.9 ||
            !["in_stock", "out_of_stock", "preorder", "backorder"].includes(candidate.basedOn.status)) {
            errors.push({
                code: "INVALID_PROVENANCE",
                message: "Candidate provenance is not a conclusive JSON-LD observation for its domain.",
            });
        }
    }
    catch {
        errors.push({ code: "INVALID_PROVENANCE", message: "Candidate observation URL is invalid." });
    }
    if (actualHash !== candidate.sourceSha256) {
        errors.push({ code: "SOURCE_HASH_MISMATCH", message: "Candidate source fingerprint changed." });
    }
    if (candidate.candidateId !== `${candidate.spec.adapterId}-${actualHash.slice(0, 12)}`) {
        errors.push({ code: "CANDIDATE_ID_MISMATCH", message: "Candidate identity does not match its source." });
    }
    const expectedSource = renderAdapterSource(candidate.spec);
    if (candidate.source !== expectedSource) {
        errors.push({
            code: "SOURCE_TEMPLATE_MISMATCH",
            message: "Candidate source is not the approved deterministic template.",
        });
    }
    const imports = [...candidate.source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
    if (imports.length !== 1 || imports[0] !== APPROVED_IMPORT) {
        errors.push({
            code: "IMPORT_NOT_ALLOWED",
            message: "Candidate source contains an import outside the strict allowlist.",
        });
    }
    for (const [pattern, label] of FORBIDDEN_SOURCE_PATTERNS) {
        if (pattern.test(candidate.source)) {
            errors.push({ code: "FORBIDDEN_API", message: `Candidate source contains ${label}.` });
        }
    }
    const compilation = ts.transpileModule(candidate.source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            strict: true,
        },
        reportDiagnostics: true,
        fileName: "adapter.ts",
    });
    for (const diagnostic of compilation.diagnostics ?? []) {
        if (diagnostic.category !== ts.DiagnosticCategory.Error)
            continue;
        errors.push({
            code: "COMPILE_ERROR",
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        });
    }
    return { passed: errors.length === 0, errors };
}
