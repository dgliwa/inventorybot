import { normalizeDomain } from "./url.js";
export class AdapterRegistry {
    #adapters = [];
    constructor(adapters = []) {
        for (const adapter of adapters) {
            this.register(adapter);
        }
    }
    register(adapter) {
        if (this.#adapters.some(({ id }) => id === adapter.id)) {
            throw new Error(`Adapter already registered: ${adapter.id}`);
        }
        this.#adapters.push(adapter);
    }
    get(url) {
        normalizeDomain(url);
        return this.#adapters.find((adapter) => adapter.canHandle(url));
    }
    list() {
        return [...this.#adapters];
    }
}
