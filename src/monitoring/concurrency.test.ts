import { describe, expect, it } from "vitest";
import { DomainConcurrencyLimiter } from "./concurrency.js";

describe("DomainConcurrencyLimiter", () => {
  it("serializes the same domain while allowing another domain", async () => {
    const limiter = new DomainConcurrencyLimiter(1);
    const events: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = limiter.run("shop.example", async () => {
      events.push("first-start");
      await held;
      events.push("first-end");
    });
    const second = limiter.run("shop.example", async () => {
      events.push("second");
    });
    const other = limiter.run("other.example", async () => {
      events.push("other");
    });
    await other;
    expect(events).toEqual(["first-start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "other", "first-end", "second"]);
  });
});
