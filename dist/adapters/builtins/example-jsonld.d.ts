import { type InventoryResult } from "../../domain/inventory.js";
import type { InventoryCheckContext, RetailerAdapter } from "../types.js";
export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export declare class ExampleJsonLdAdapter implements RetailerAdapter {
    private readonly httpFetch;
    readonly id = "example-retailer-jsonld";
    readonly version = "1.0.0";
    readonly domains: string[];
    constructor(httpFetch?: HttpFetch);
    canHandle(url: string): boolean;
    checkInventory(url: string, context?: InventoryCheckContext): Promise<InventoryResult>;
}
