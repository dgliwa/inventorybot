import type { RetailerAdapter } from "./types.js";
export declare class AdapterRegistry {
    #private;
    constructor(adapters?: RetailerAdapter[]);
    register(adapter: RetailerAdapter): void;
    get(url: string): RetailerAdapter | undefined;
    list(): readonly RetailerAdapter[];
}
