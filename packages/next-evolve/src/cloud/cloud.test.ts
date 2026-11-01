import {
  type FakeCloud,
  startFakeCloud,
  TEST_SECRET_KEY,
  TEST_SITE,
} from "@next-evolve/fake-cloud";
import { computeManifestHash } from "@next-evolve/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineConfig } from "../config/config";
import { defineGoals } from "../config/goals";
import { registerEvolve, resetRegisterEvolve } from "../instrumentation";
import { buildManifest, detectAppUrl } from "./manifest";
import { pushToCloud } from "./push";
import { registerRegion, resetRegionRegistry } from "./regions";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
  vi.stubEnv("EVOLVE_SECRET_KEY", TEST_SECRET_KEY);
  vi.stubEnv("EVOLVE_CLOUD_URL", cloud.url);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await cloud.close();
});
afterEach(() => {
  resetRegionRegistry();
  resetRegisterEvolve();
});

const config = defineConfig({
  routes: { "/": { mode: "static" }, "/features/": { mode: "dynamic" } },
});
const goals = defineGoals({
  signup: { event: "signup" },
  pricing_view: { pageview: "/pricing" },
  revenue: { event: "purchase", value: () => 1 },
});

describe("manifest", () => {
  it("serializes routes (normalized), goals (functions → local-fn) and versions", () => {
    const m = buildManifest(config, goals, { appUrl: "https://acme.com" });
    expect(m.routes).toEqual({ "/": { mode: "static" }, "/features": { mode: "dynamic" } });
    expect(m.goals.revenue).toMatchObject({ kind: "event", value: { kind: "local-fn" } });
    expect(m).toMatchObject({ pv: 1, protocol: { supported: [1] }, appUrl: "https://acme.com" });
    expect(m.nextVersion).toMatch(/^\d+\.\d+/);
    expect(m.hash).toBe(computeManifestHash(m));
  });

  it("detects the app URL", () => {
    expect(detectAppUrl({ EVOLVE_APP_URL: "https://acme.com/" })).toBe("https://acme.com");
    expect(
      detectAppUrl({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "acme.vercel.app" }),
    ).toBe("https://acme.vercel.app");
    expect(detectAppUrl({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "x" })).toBeNull();
  });

  it("registerEvolve pushes it once per process", async () => {
    await registerEvolve({ config, goals });
    await registerEvolve({ config, goals });
    expect(cloud.manifests.get(TEST_SITE)?.goals.signup).toMatchObject({ event: "signup" });
    expect(cloud.calls.filter((c) => c.path === "/v1/manifest")).toHaveLength(1);
  });
});

describe("region registration", () => {
  const region = {
    id: "hero",
    jsonSchema: { type: "object" },
    schemaHash: "b".repeat(64),
    controlProps: { title: "Ship faster" },
    path: "/",
  };

  it("pushes a region once per (id, schema, path)", async () => {
    const before = cloud.calls.filter((c) => c.path === "/v1/regions").length;
    await registerRegion(region);
    await registerRegion(region);
    await registerRegion({ ...region, path: "/pricing" });
    expect(cloud.calls.filter((c) => c.path === "/v1/regions").length - before).toBe(2);
    expect(cloud.regions.get(TEST_SITE)?.get("hero")?.controlProps).toEqual({
      title: "Ship faster",
    });
  });

  it("retries on a later render after a failure", async () => {
    vi.stubEnv("EVOLVE_CLOUD_URL", "http://127.0.0.1:1"); // nothing listens there
    await registerRegion(region);
    vi.stubEnv("EVOLVE_CLOUD_URL", cloud.url);
    const before = cloud.calls.filter((c) => c.path === "/v1/regions").length;
    await registerRegion(region);
    expect(cloud.calls.filter((c) => c.path === "/v1/regions").length).toBe(before + 1);
  });
});

describe("pushToCloud", () => {
  it("is a no-op without a secret key and never throws", async () => {
    expect(await pushToCloud("/v1/manifest", {}, { env: {} })).toEqual({
      ok: false,
      status: "no_key",
    });
    expect(
      await pushToCloud(
        "/v1/manifest",
        {},
        { env: { EVOLVE_SECRET_KEY: "x", EVOLVE_CLOUD_URL: "http://127.0.0.1:1" } },
      ),
    ).toEqual({ ok: false, status: "network" });
    expect(
      await pushToCloud(
        "/v1/manifest",
        { bad: true },
        { env: { EVOLVE_SECRET_KEY: TEST_SECRET_KEY, EVOLVE_CLOUD_URL: cloud.url } },
      ),
    ).toEqual({ ok: false, status: 400 });
  });
});
