import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainMatches, normalizeDomain } from "../adapters/url.js";
const CONCLUSIVE_STATUSES = new Set(["in_stock", "out_of_stock", "preorder", "backorder"]);
export function normalizeAdapterDomain(value) {
    const trimmed = value.trim().toLocaleLowerCase().replace(/^www\./, "");
    if (!trimmed ||
        trimmed.includes("/") ||
        trimmed.includes(":") ||
        trimmed === "localhost" ||
        trimmed.endsWith(".localhost") ||
        isIP(trimmed) !== 0) {
        return undefined;
    }
    try {
        const hostname = new URL(`https://${trimmed}`).hostname;
        return hostname.includes(".") ? hostname : undefined;
    }
    catch {
        return undefined;
    }
}
export function renderAdapterSource(spec) {
    return `import { createGeneratedJsonLdAdapter } from "../../src/generation/generated-jsonld-adapter.js";\n\nexport default createGeneratedJsonLdAdapter(${JSON.stringify({
        id: spec.adapterId,
        version: spec.version,
        domains: [spec.domain],
    }, null, 2)});\n`;
}
export function generateRetailerAdapter(domainInput, observations, options = {}) {
    const domain = normalizeAdapterDomain(domainInput);
    if (!domain) {
        return {
            generated: false,
            error: { code: "INVALID_DOMAIN", message: "A public retailer hostname is required." },
        };
    }
    const observation = [...observations]
        .filter((candidate) => {
        try {
            return (candidate.method === "json_ld" &&
                candidate.confidence >= 0.9 &&
                CONCLUSIVE_STATUSES.has(candidate.status) &&
                domainMatches(normalizeDomain(candidate.url), domain) &&
                (candidate.productMatchConfidence === undefined ||
                    candidate.productMatchConfidence >= 0.8));
        }
        catch {
            return false;
        }
    })
        .sort((left, right) => right.confidence - left.confidence)[0];
    if (!observation) {
        return {
            generated: false,
            error: {
                code: "INSUFFICIENT_OBSERVATIONS",
                message: "Generation requires a conclusive, high-confidence JSON-LD observation for this domain.",
            },
        };
    }
    const adapterId = `generated-${domain.replace(/[^a-z0-9]+/g, "-")}-jsonld`;
    const spec = { adapterId, version: "1.0.0", domain, strategy: "json_ld" };
    const source = renderAdapterSource(spec);
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const candidate = {
        candidateId: `${adapterId}-${sourceSha256.slice(0, 12)}`,
        lifecycle: "candidate",
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        generationReason: options.generationReason ?? "unsupported_retailer",
        spec,
        source,
        sourceSha256,
        basedOn: observation,
        requiresApproval: true,
    };
    return { generated: true, candidate };
}
