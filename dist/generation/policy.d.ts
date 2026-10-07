import type { AdapterCandidate } from "./types.js";
export type StaticPolicyResult = {
    passed: boolean;
    errors: Array<{
        code: string;
        message: string;
    }>;
};
export declare function validateCandidateSource(candidate: AdapterCandidate): StaticPolicyResult;
