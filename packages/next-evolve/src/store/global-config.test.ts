import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineConfig } from "../config/config";
import { evolveReady } from "../proxy/proxy";
import {
  COLD_READ_CAP_MS,
  createGlobalConfigFetcher,
  GLOBAL_CONFIG_TTL_MS,
  globalConfigItemKey,
  globalConfigSettings,
  writeGlobalConfig,
} from "./global-config";
import { getBundleStore, resetBundleStores } from "./runtime";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(() => cloud.close());
beforeEach(() => {
  resetBundleStores();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const content = { routing: { routes: { "/": [] }, experiments: {} }, variants: {} };
const publish = () => cloud.publish({ site: TEST_SITE, ...content });
const env = (o: Record<string, string | undefined> = {}) => ({
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_CLOUD_URL: cloud.url,
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  EVOLVE_GLOBAL_CONFIG: "https://edge-config.vercel.com/ecfg_x?token=t",
  VERCEL: "1",
  NODE_ENV: "test",
  ...o,
});

describe("Global Config settings", () => {
  it('"auto" uses it only with EVOLVE_GLOBAL_CONFIG; "memory" never', () => {
    expect(globalConfigSettings("auto", {})).toBeNull();
    expect(globalConfigSettings(undefined, env())?.connectionString).toContain("ecfg_x");
    expect(globalConfigSettings("memory", env())).toBeNull();
    expect(globalConfigSettings("global-config", {})).toBeNull(); // logs, falls back
  });
});

describe("Global Config fetcher", () => {
  const item = globalConfigItemKey(TEST_SITE);

  it("reads the site's item; asks the cloud only every cloudEveryMs; returns the newer token", async () => {
    const older = publish().token;
    const newer = publish().token;
    let t = 0;
    const read = vi.fn(async (k: string) => (k === item ? older : undefined));
    const cloudFetch = vi.fn(async () => ({ status: "ok" as const, token: newer, etag: null }));
    const f = createGlobalConfigFetcher({
      site: TEST_SITE,
      read,
      cloud: cloudFetch,
      cloudEveryMs: 60_000,
      now: () => t,
    });
    expect(await f(null)).toEqual({ status: "ok", token: newer, etag: null });
    t += 10_000;
    expect(await f(null)).toEqual({ status: "ok", token: older, etag: null });
    expect(cloudFetch).toHaveBeenCalledTimes(1);
    t += 60_000;
    await f(null);
    expect(cloudFetch).toHaveBeenCalledTimes(2);
  });

  it("empty item or a read error → the cloud; matching etag → not_modified", async () => {
    const { token, payload } = publish();
    const cloudFetch = vi.fn(async () => ({ status: "ok" as const, token, etag: null }));
    const empty = createGlobalConfigFetcher({
      site: TEST_SITE,
      read: async () => undefined,
      cloud: cloudFetch,
      cloudEveryMs: 60_000,
    });
    expect((await empty(null)).status).toBe("ok");
    const broken = createGlobalConfigFetcher({
      site: TEST_SITE,
      read: async () => {
        throw new Error("down");
      },
      cloud: cloudFetch,
      cloudEveryMs: 60_000,
    });
    expect((await broken(null)).status).toBe("ok");
    const same = createGlobalConfigFetcher({
      site: TEST_SITE,
      read: async () => token,
      cloudEveryMs: 60_000,
    });
    expect(await same(`"${payload.ver}.${payload.iat}"`)).toEqual({ status: "not_modified" });
  });

  it("the cloud's 410 site_deleted wins over a stale Global Config item", async () => {
    const { token } = publish();
    const deleted = {
      status: "error" as const,
      code: 410,
      message: '{"error":"site_deleted"}',
    };
    const f = createGlobalConfigFetcher({
      site: TEST_SITE,
      read: async () => token,
      cloud: async () => deleted,
      cloudEveryMs: 60_000,
    });
    expect(await f(null)).toEqual(deleted);
  });
});

describe("Global Config store", () => {
  it("instances re-read every 10 s and verify what they read (a forged item is rejected)", async () => {
    const { token } = publish();
    const read = vi.fn(async () => token);
    const store = getBundleStore(
      { pollSeconds: 60 },
      { env: env({ EVOLVE_CLOUD_URL: "http://127.0.0.1:1" }), globalConfigReader: read },
    )!;
    await store.refresh();
    expect(store.token()).toBe(token);

    resetBundleStores();
    const forged = `${token.slice(0, -4)}AAAA`;
    const s2 = getBundleStore(
      {},
      {
        env: env({ EVOLVE_CLOUD_URL: "http://127.0.0.1:1" }),
        globalConfigReader: async () => forged,
      },
    )!;
    await s2.refresh();
    expect(s2.current()).toBeNull();
  });

  it(`cold start waits for one read, capped at ${COLD_READ_CAP_MS} ms, then serves what it has`, async () => {
    const { token } = publish();
    const config = defineConfig({ routes: { "/": { mode: "static" } } });
    const fast = { env: env(), globalConfigReader: async () => token };
    const t0 = performance.now();
    await evolveReady(config, fast);
    expect(getBundleStore({}, fast)!.token()).toBe(token);
    expect(evolveReady(config, fast)).toBeNull(); // only the first request waits

    resetBundleStores();
    const slow = {
      env: env({ EVOLVE_CLOUD_URL: "http://127.0.0.1:1" }),
      globalConfigReader: () => new Promise<string>((r) => setTimeout(() => r(token), 500)),
      buildBundle: token,
    };
    const t1 = performance.now();
    await evolveReady(config, slow);
    expect(performance.now() - t1).toBeLessThan(200);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(getBundleStore({}, slow)!.token()).toBe(token); // the build bundle serves

    resetBundleStores();
    expect(evolveReady(config, { env: env({ EVOLVE_GLOBAL_CONFIG: undefined }) })).toBeNull();
  });
});

describe("writeGlobalConfig (sync route)", () => {
  it("upserts the site's item via the Vercel API", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    const ok = await writeGlobalConfig(
      { connectionString: "x", id: "ecfg_abc", apiToken: "vt_1", teamId: "team_9" },
      TEST_SITE,
      "tok",
      f as unknown as typeof fetch,
    );
    expect(ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.vercel.com/v1/edge-config/ecfg_abc/items?teamId=team_9");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer vt_1");
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ operation: "upsert", key: `evolve_bundle_${TEST_SITE}`, value: "tok" }],
    });
  });

  it("read-only without id/token, false on HTTP errors", async () => {
    expect(await writeGlobalConfig({ connectionString: "x" }, TEST_SITE, "tok")).toBe(false);
    const f = async () => new Response("nope", { status: 403 });
    expect(
      await writeGlobalConfig(
        { connectionString: "x", id: "i", apiToken: "t" },
        TEST_SITE,
        "tok",
        f as unknown as typeof fetch,
      ),
    ).toBe(false);
  });
});

// T19.5 drill: the fixture's item was a days-old bundle (read-only Global Config),
// so a refresh inside the 60 s cloud window found nothing newer.
describe("Global Config fetcher, stale item (T19.5)", () => {
  const item = globalConfigItemKey(TEST_SITE);

  it("{ cloud: true } asks the cloud even inside cloudEveryMs", async () => {
    const stale = publish().token;
    const fresh = publish().token;
    const cloudFetch = vi.fn(async () => ({ status: "ok" as const, token: fresh, etag: null }));
    const f = createGlobalConfigFetcher({
      site: TEST_SITE,
      read: async (k) => (k === item ? stale : undefined),
      cloud: cloudFetch,
      cloudEveryMs: 60_000,
      now: () => 0,
    });
    await f(null);
    expect(await f(null)).toEqual({ status: "ok", token: stale, etag: null });
    expect(await f(null, { cloud: true })).toEqual({ status: "ok", token: fresh, etag: null });
    expect(cloudFetch).toHaveBeenCalledTimes(2);
  });

  it("a failed cloud call doesn't start a new cloudEveryMs wait: the next read asks again", async () => {
    const stale = publish().token;
    const fresh = publish().token;
    let fail = true;
    const cloudFetch = vi.fn(async () =>
      fail
        ? ({ status: "error", code: "network" } as const)
        : ({ status: "ok", token: fresh, etag: null } as const),
    );
    let t = 0;
    const f = createGlobalConfigFetcher({
      site: TEST_SITE,
      read: async () => stale,
      cloud: cloudFetch,
      cloudEveryMs: 60_000,
      now: () => t,
    });
    expect(await f(null)).toEqual({ status: "ok", token: stale, etag: null });
    fail = false;
    t += 10_000;
    expect(await f(null)).toEqual({ status: "ok", token: fresh, etag: null });
    expect(cloudFetch).toHaveBeenCalledTimes(2);
  });
});

describe("Global Config TTL (T19.5 propagation)", () => {
  it("instances re-read every 5 s, so a pause written by the sync route is live in ≤ ~5 s", async () => {
    expect(GLOBAL_CONFIG_TTL_MS).toBe(5_000);
    const { token } = publish();
    const read = vi.fn(async () => token);
    const store = getBundleStore(
      { pollSeconds: 60 },
      { env: env({ EVOLVE_CLOUD_URL: "http://127.0.0.1:1" }), globalConfigReader: read },
    )!;
    await store.refresh();
    expect(read).toHaveBeenCalledTimes(1);
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + GLOBAL_CONFIG_TTL_MS * 1.1);
    store.peek();
    expect(read).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockRestore();
  });
});
