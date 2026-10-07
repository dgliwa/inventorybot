import { type HttpFetch } from "../adapters/builtins/example-jsonld.js";
import type { RetailerAdapter } from "../adapters/types.js";
export type GeneratedJsonLdAdapterConfig = {
    id: string;
    version: string;
    domains: string[];
};
export declare function createGeneratedJsonLdAdapter(config: GeneratedJsonLdAdapterConfig, httpFetch?: HttpFetch): RetailerAdapter;
