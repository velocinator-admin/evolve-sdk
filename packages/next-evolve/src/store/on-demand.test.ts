import { describe, expect, it, vi } from "vitest";
import { createRefreshLimiter, ON_DEMAND_MIN_INTERVAL_MS } from "./on-demand";

/** A limiter on a fake clock; `sleep` advances the clock instead of waiting. */
function setup() {
  let t = 1_000_000;
  const pending: Array<() => void> = [];
  const refresh = vi.fn(
    () =>
      new Promise<void>((r) => {
        pending.push(r);
      }),
  );
  const slept: number[] = [];
  const limiter = createRefreshLimiter(refresh, {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  const settle = async () => {
    pending.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { limiter, refresh, settle, slept, advance: (ms: number) => (t += ms) };
}

describe("on-demand refresh limiter", () => {
  it("nowOrSkip: shares the fetch in flight; inside the window it doesn't fetch", async () => {
    const s = setup();
    const a = s.limiter.nowOrSkip();
    const b = s.limiter.nowOrSkip();
    expect(s.refresh).toHaveBeenCalledTimes(1);
    await s.settle();
    await Promise.all([a, b]);
    await s.limiter.nowOrSkip(); // inside the window: resolves at once
    expect(s.refresh).toHaveBeenCalledTimes(1);
    s.advance(ON_DEMAND_MIN_INTERVAL_MS);
    void s.limiter.nowOrSkip();
    expect(s.refresh).toHaveBeenCalledTimes(2);
  });

  it("soon: inside the window it waits for the next slot instead of giving up", async () => {
    const s = setup();
    void s.limiter.nowOrSkip();
    await s.settle();
    s.advance(1_000);
    const later = s.limiter.soon();
    const same = s.limiter.soon(); // shares the queued fetch
    await new Promise((r) => setTimeout(r, 0));
    expect(s.slept).toEqual([ON_DEMAND_MIN_INTERVAL_MS - 1_000]);
    expect(s.refresh).toHaveBeenCalledTimes(2);
    await s.settle();
    await Promise.all([later, same]);
    expect(s.refresh).toHaveBeenCalledTimes(2);
  });

  it("soon: shares a fetch in flight (the caller re-checks, then asks again)", async () => {
    const s = setup();
    const first = s.limiter.soon();
    const second = s.limiter.soon();
    expect(s.refresh).toHaveBeenCalledTimes(1);
    await s.settle();
    await Promise.all([first, second]);
  });

  it("many forged callers: at most one fetch per window", async () => {
    const s = setup();
    const all: Promise<void>[] = [];
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) all.push(s.limiter.soon(), s.limiter.nowOrSkip());
      await new Promise((r) => setTimeout(r, 0));
      await s.settle();
    }
    await Promise.all(all);
    // 120 calls; the clock only moves by the limiter's own sleeps, so the
    // fetch count is bounded by elapsed time / window.
    const elapsed = s.slept.reduce((a, b) => a + b, 0);
    expect(s.refresh).toHaveBeenCalledTimes(3);
    expect(s.refresh.mock.calls.length).toBeLessThanOrEqual(
      1 + elapsed / ON_DEMAND_MIN_INTERVAL_MS,
    );
  });

  it("a failing refresh never rejects", async () => {
    const limiter = createRefreshLimiter(() => Promise.reject(new Error("down")));
    await expect(limiter.nowOrSkip()).resolves.toBeUndefined();
  });
});
