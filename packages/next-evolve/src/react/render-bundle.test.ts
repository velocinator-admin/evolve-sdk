import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
} from "@next-evolve/fake-cloud";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLE_TAG } from "../server/sync-route";
import { getBundleStore, resetBundleStores } from "../store/runtime";
import { FRESH_MIN_INTERVAL_MS, getRenderBundle } from "./render-bundle";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(() => cloud.close());
beforeEach(() => {
  resetBundleStores();
  vi.stubEnv("EVOLVE_SECRET_KEY", TEST_SECRET_KEY);
  vi.stubEnv("EVOLVE_CLOUD_URL", cloud.url);
  vi.stubEnv("EVOLVE_UNSAFE_TEST_PUBLIC_KEY", TEST_PUBLIC_KEY_ENV);
  vi.stubEnv("VERCEL", "1"); // no disk cache
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const content = { routing: { routes: { "/": [] }, experiments: {} }, variants: {} };

describe("getRenderBundle (spec §7.7)", () => {
  it("cold: fetches through Next's data cache with the evolve-bundle tag and installs it", async () => {
    const { payload } = cloud.publish({ site: TEST_SITE, ...content });
    const spy = vi.fn(fetch);
    vi.stubGlobal("fetch", spy);
    const b = await getRenderBundle();
    expect(b?.ver).toBe(payload.ver);
    const init = spy.mock.calls[0]![1] as RequestInit & { next?: { tags?: string[] } };
    expect(String(spy.mock.calls[0]![0])).toBe(`${cloud.url}/v1/bundle`);
    expect(init.next?.tags).toEqual([BUNDLE_TAG]);
    expect(init.cache).toBe("force-cache");
    expect(getBundleStore({})!.current()?.ver).toBe(payload.ver);
  });

  it("warm: memory, no fetch", async () => {
    cloud.publish({ site: TEST_SITE, ...content });
    await getBundleStore({})!.refresh();
    const spy = vi.fn(fetch);
    vi.stubGlobal("fetch", spy);
    expect(await getRenderBundle()).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fresh: an uncached pull (a variant the cached bundle doesn't know yet)", async () => {
    cloud.publish({ site: TEST_SITE, ...content });
    await getRenderBundle();
    const { payload } = cloud.publish({ site: TEST_SITE, ...content });
    expect((await getRenderBundle({ fresh: true }))?.ver).toBe(payload.ver);
  });

  it("fresh is rate-limited per instance: N unknown codes → ≤ 1 pull per window (forged codes)", async () => {
    cloud.publish({ site: TEST_SITE, ...content });
    let t = 1_000_000;
    const now = () => t;
    await getRenderBundle();
    const before = cloud.calls.filter((c) => c.path === "/v1/bundle").length;
    const pulls = () => cloud.calls.filter((c) => c.path === "/v1/bundle").length - before;
    // Sequential and concurrent calls inside one window share one pull.
    for (let i = 0; i < 5; i++) await getRenderBundle({ fresh: true, now });
    await Promise.all(Array.from({ length: 20 }, () => getRenderBundle({ fresh: true, now })));
    expect(pulls()).toBe(1);
    // Limited calls still return the bundle the instance has (never null because of the limit).
    expect(await getRenderBundle({ fresh: true, now })).not.toBeNull();
    t += FRESH_MIN_INTERVAL_MS - 1;
    await getRenderBundle({ fresh: true, now });
    expect(pulls()).toBe(1);
    t += 1;
    const { payload } = cloud.publish({ site: TEST_SITE, ...content });
    expect((await getRenderBundle({ fresh: true, now }))?.ver).toBe(payload.ver);
    expect(pulls()).toBe(2);
  });

  it("concurrent fresh calls wait for the pull in flight and see its result", async () => {
    cloud.publish({ site: TEST_SITE, ...content });
    await getRenderBundle();
    const { payload } = cloud.publish({ site: TEST_SITE, ...content });
    const all = await Promise.all(
      Array.from({ length: 5 }, () => getRenderBundle({ fresh: true, now: () => 5e9 })),
    );
    expect(all.map((b) => b?.ver)).toEqual(Array(5).fill(payload.ver));
  });

  it("a failing tagged fetch falls back to the store (never throws)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getRenderBundle()).toBeNull();
  });
});
