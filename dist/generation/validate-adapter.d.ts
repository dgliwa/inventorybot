import type { HttpFetch } from "../adapters/builtins/example-jsonld.js";
import type { AdapterCandidate, AdapterFixture, AdapterLiveValidation, AdapterValidationReport } from "./types.js";
export declare function validateRetailerAdapter(candidate: AdapterCandidate, testContext: {
    fixture?: AdapterFixture;
    live?: AdapterLiveValidation;
}, dependencies?: {
    liveFetch?: HttpFetch;
    now?: () => Date;
}): Promise<AdapterValidationReport>;
