import type { RetailerAdapter } from "./types.js";
import { normalizeDomain } from "./url.js";

export class AdapterRegistry {
  readonly #adapters: RetailerAdapter[] = [];

  constructor(adapters: RetailerAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: RetailerAdapter): void {
    if (this.#adapters.some(({ id }) => id === adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    this.#adapters.push(adapter);
  }

  get(url: string): RetailerAdapter | undefined {
    normalizeDomain(url);
    return this.#adapters.find((adapter) => adapter.canHandle(url));
  }

  list(): readonly RetailerAdapter[] {
    return [...this.#adapters];
  }
}
