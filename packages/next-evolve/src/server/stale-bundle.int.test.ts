// T19.5 drill, reproduced: on the Vercel fixture, idle instances held an old
// bundle for minutes, and collect dropped the exposures and vitals of real
// visits to an experiment started meanwhile. The fixture's Global Config is
// read-only, so its item is a days-old bundle; instances only asked the cloud
// once per 60 s, and collect's one awaited refresh read that stale item.
import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshSchema, TEST_DB_URL, testSql } from "../../test/db";
import { defineConfig, resolveConfig } from "../config/config";
import { closeAllSql } from "../db/client";
import { getBundleStore, resetBundleStores } from "../store/runtime";
import { createEvolveHandler } from "./handler";
import { resetRuntime, runtimeWriter } from "./runtime";

const sql = testSql();
let cloud: FakeCloud;
const config = defineConfig({ routes: { "/": { mode: "static" }, "/slow": { mode: "dynamic" } } });

const hero = {
  status: "running" as const,
  traffic: 1,
  control: "a8f2l1",
  variants: [
    { id: "a8f2l1", w: 0.5 },
    { id: "c1d2e3", w: 0.5 },
  ],
};
const heroVariants = {
  a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
  c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "B" } },
};
/** Bundle before the drill: only the hero test. */
const before = { routes: { "/": ["k3j9x2"] }, experiments: { k3j9x2: hero } };
/** After "Start" in the dashboard: the slow-image test on /slow. */
const after = {
  routes: { "/": ["k3j9x2"], "/slow": ["vp0zaz"] },
  experiments: {
    k3j9x2: hero,
    vp0zaz: {
      status: "running" as const,
      traffic: 1,
      control: "y52vdj",
      variants: [
        { id: "y52vdj", w: 0.5 },
        { id: "q8sr2t", w: 0.5 },
      ],
    },
  },
};
const afterVariants = {
  ...heroVariants,
  y52vdj: { exp: "vp0zaz", region: "slow-hero", ctrl: true, props: {} },
  q8sr2t: { exp: "vp0zaz", region: "slow-hero", ctrl: false, props: { slowImageMs: 1500 } },
};

beforeAll(async () => {
  cloud = await startFakeCloud();
});
beforeEach(async () => {
  await freshSchema(sql);
  resetBundleStores();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  await runtimeWriter().flush();
  resetRuntime();
  resetBundleStores();
  await closeAllSql();
  await sql.end();
  await cloud.close();
});

const env = {
  EVOLVE_DATABASE_URL: TEST_DB_URL,
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_CLOUD_URL: "",
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  EVOLVE_GLOBAL_CONFIG: "https://edge-config.vercel.com/ecfg_fixture?token=read-only",
  VERCEL: "1",
  NODE_ENV: "test",
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const beacon = (POST: (r: Request) => Promise<Response>, anon: string, events: unknown[]) =>
  POST(
    new Request("https://fixture.test/api/evolve/collect", {
      method: "POST",
      body: JSON.stringify({ v: 1, events }),
      headers: {
        host: "fixture.test",
        origin: "https://fixture.test",
        "user-agent": UA,
        cookie: `evolve_id=${anon}`,
      },
    }),
  );

describe("an instance holding an older bundle gets beacons for a newer experiment", () => {
  it("counts the exposures and vitals (refreshes from the cloud, past a stale Global Config item)", async () => {
    const e = { ...env, EVOLVE_CLOUD_URL: cloud.url };
    const old = cloud.publish({ site: TEST_SITE, routing: before, variants: heroVariants });
    const pulls0 = cloud.calls.filter((c) => c.path === "/v1/bundle").length;

    // A collect instance that polled recently: Global Config holds the old
    // bundle (nobody can write it), and its last cloud check was just now.
    const store = getBundleStore(resolveConfig(config), {
      env: e,
      globalConfigReader: async () => old.token,
    })!;
    await store.refresh();
    expect(store.current()?.ver).toBe(old.payload.ver);

    // The drill's "Start": a newer bundle with a new experiment, no webhook here.
    const started = cloud.publish({ site: TEST_SITE, routing: after, variants: afterVariants });

    const { POST } = createEvolveHandler({ config, env: e });
    // A real visit sends the exposure and, later, its vitals; a second visitor
    // lands on the same instance at the same time.
    const statuses = await Promise.all([
      beacon(POST, "AAAAAAAAAAAAAAAAAAAAAA", [
        { t: "pv", p: "/slow" },
        { t: "exp", e: "vp0zaz", v: "q8sr2t", p: "/slow" },
      ]),
      beacon(POST, "AAAAAAAAAAAAAAAAAAAAAA", [
        { t: "exp", e: "vp0zaz", v: "q8sr2t", p: "/slow" },
        { t: "cwv", m: "lcp", v: 1850, p: "/slow" },
      ]),
      beacon(POST, "BBBBBBBBBBBBBBBBBBBBBB", [
        { t: "exp", e: "vp0zaz", v: "y52vdj", p: "/slow" },
        { t: "cwv", m: "lcp", v: 400, p: "/slow" },
      ]),
    ]);
    expect(statuses.map((r) => r.status)).toEqual([204, 204, 204]);
    await runtimeWriter().flush();

    expect(store.current()?.ver).toBe(started.payload.ver);
    const exposures =
      await sql`select anon_id, variant_id from evolve.exposures where experiment_id = 'vp0zaz' order by anon_id`;
    expect(exposures.map((r) => `${r.anon_id.slice(0, 1)}:${r.variant_id}`)).toEqual([
      "A:q8sr2t",
      "B:y52vdj",
    ]);
    const vitals =
      await sql`select variant_id, sum(count)::int as n from evolve.vitals_daily where experiment_id = 'vp0zaz' group by variant_id order by variant_id`;
    expect(vitals.map((r) => `${r.variant_id}=${r.n}`)).toEqual(["q8sr2t=1", "y52vdj=1"]);
    // One cloud fetch for all three beacons (the on-demand budget).
    const pulls = cloud.calls.filter((c) => c.path === "/v1/bundle").length - pulls0;
    expect(pulls).toBe(2); // the poll above + one on-demand
  });

  it("a forged pair is still dropped, after at most one on-demand cloud fetch", async () => {
    const e = { ...env, EVOLVE_CLOUD_URL: cloud.url };
    const old = cloud.publish({ site: TEST_SITE, routing: before, variants: heroVariants });
    const store = getBundleStore(resolveConfig(config), {
      env: e,
      globalConfigReader: async () => old.token,
    })!;
    await store.refresh();
    const before0 = cloud.calls.filter((c) => c.path === "/v1/bundle").length;
    const { POST } = createEvolveHandler({ config, env: e });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        beacon(POST, "CCCCCCCCCCCCCCCCCCCCCC", [{ t: "exp", e: "zzzzzz", v: "yyyyyy", p: "/" }]),
      ),
    );
    await runtimeWriter().flush();
    expect(await sql`select 1 from evolve.exposures`).toHaveLength(0);
    expect(cloud.calls.filter((c) => c.path === "/v1/bundle").length - before0).toBeLessThanOrEqual(
      2,
    );
  }, 20_000);
});
