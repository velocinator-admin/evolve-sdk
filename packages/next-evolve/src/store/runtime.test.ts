import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { diskPath } from "./disk";
import { getBundleStore, isLongRunningNode, resetBundleStores } from "./runtime";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(() => cloud.close());

let dir: string;
beforeEach(() => {
  resetBundleStores();
  dir = mkdtempSync(join(tmpdir(), "evolve-disk-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const env = (o: Record<string, string> = {}) => ({
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_CLOUD_URL: cloud.url,
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  NODE_ENV: "test",
  ...o,
});
const content = { routing: { routes: { "/": [] }, experiments: {} }, variants: {} };
const publish = () => cloud.publish({ site: TEST_SITE, ...content });

describe("Node chain: disk cache (spec §7.8)", () => {
  it("persists each accepted bundle; a restart with the cloud down serves it from disk", async () => {
    const { payload } = publish();
    const store = getBundleStore({ pollSeconds: 60 }, { env: env(), diskDir: dir })!;
    await store.refresh();
    expect(store.current()?.ver).toBe(payload.ver);
    expect(readFileSync(diskPath(dir, TEST_SITE), "utf8")).toBe(store.token());

    resetBundleStores(); // restart
    const down = env({ EVOLVE_CLOUD_URL: "http://127.0.0.1:1" });
    const after = getBundleStore({ pollSeconds: 60 }, { env: down, diskDir: dir })!;
    expect(after.peek()?.ver).toBe(payload.ver);
  });

  it("the newer of build bundle and disk wins", async () => {
    const old = publish().token;
    const newer = publish().token;
    writeFileSync(diskPath(dir, TEST_SITE), newer);
    const a = getBundleStore({}, { env: env(), diskDir: dir, buildBundle: old })!;
    expect(a.token()).toBe(newer);
    resetBundleStores();
    writeFileSync(diskPath(dir, TEST_SITE), old);
    const b = getBundleStore({}, { env: env(), diskDir: dir, buildBundle: newer })!;
    expect(b.token()).toBe(newer);
  });

  it("ignores a corrupt disk file", () => {
    writeFileSync(diskPath(dir, TEST_SITE), "garbage");
    const s = getBundleStore({}, { env: env(), diskDir: dir })!;
    expect(s.current()).toBeNull();
  });

  it("no disk on Vercel or Lambda", async () => {
    publish();
    const s = getBundleStore({}, { env: env({ VERCEL: "1" }), diskDir: dir })!;
    await s.refresh();
    expect(s.current()).not.toBeNull();
    expect(existsSync(diskPath(dir, TEST_SITE))).toBe(false);
    expect(isLongRunningNode({ VERCEL: "1" })).toBe(false);
    expect(isLongRunningNode({ AWS_LAMBDA_FUNCTION_NAME: "f" })).toBe(false);
    expect(isLongRunningNode({})).toBe(true);
  });
});
