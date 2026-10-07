import type { ProductIdentity } from "../domain/product.js";
import type { DiscoveryResult, RetailerSearchClient } from "./types.js";
export declare function discoverRetailers(product: ProductIdentity, searchClient: RetailerSearchClient, options?: {
    resultsPerQuery?: number;
    signal?: AbortSignal;
}): Promise<DiscoveryResult>;
