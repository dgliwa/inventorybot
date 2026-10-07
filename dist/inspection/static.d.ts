import { type ProductIdentity } from "../domain/product.js";
import type { RetailerInspection } from "./types.js";
import { type HostResolver } from "./url-safety.js";
export type StaticFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare function inspectRetailerStatic(url: string, options?: {
    expectedProduct?: ProductIdentity;
    timeoutMs?: number;
    signal?: AbortSignal;
    httpFetch?: StaticFetch;
    resolveHost?: HostResolver;
}): Promise<RetailerInspection>;
