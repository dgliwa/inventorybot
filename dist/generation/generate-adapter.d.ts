import type { AdapterGenerationObservation, AdapterGenerationResult } from "./types.js";
export declare function normalizeAdapterDomain(value: string): string | undefined;
export declare function renderAdapterSource(spec: {
    adapterId: string;
    version: string;
    domain: string;
}): string;
export declare function generateRetailerAdapter(domainInput: string, observations: AdapterGenerationObservation[], options?: {
    generationReason?: "unsupported_retailer" | "repair";
    now?: () => Date;
}): AdapterGenerationResult;
