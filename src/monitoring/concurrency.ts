type DomainState = {
  active: number;
  waiting: Array<() => void>;
};

export class DomainConcurrencyLimiter {
  readonly #states = new Map<string, DomainState>();

  constructor(private readonly limit: number) {}

  async run<T>(domain: string, operation: () => Promise<T>): Promise<T> {
    const state = this.#states.get(domain) ?? { active: 0, waiting: [] };
    this.#states.set(domain, state);
    if (state.active >= this.limit) {
      await new Promise<void>((resolve) =>
        state.waiting.push(() => {
          state.active += 1;
          resolve();
        }),
      );
    } else {
      state.active += 1;
    }
    try {
      return await operation();
    } finally {
      state.active -= 1;
      state.waiting.shift()?.();
      if (state.active === 0 && state.waiting.length === 0) this.#states.delete(domain);
    }
  }
}
