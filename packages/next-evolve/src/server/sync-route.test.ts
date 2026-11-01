import {
  BUNDLE_TTL_SECONDS,
  BUNDLE_TYP,
  computeBundleHash,
  createKeyRing,
  createReplayGuard,
  PROTOCOL_VERSION,
  signBody,
} from "@next-evolve/protocol";
import { generateTestKeyPair, signJws } from "@next-evolve/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import type { FetchBundleResult } from "../store/fetch";
import { createMemoryStore } from "../store/memory";
import { createSyncThrottle, handleSync, type SyncDeps } from "./sync-route";

const SITE = "site_sync000000";
const SECRET = `whsec_${"s".repeat(32)}`;
const env = {
  EVOLVE_WEBHOOK_SECRET: SECRET,
  EVOLVE_SECRET_KEY: `evk_live_${SITE}_${"k".repeat(32)}`,
};
const key = generateTestKeyPair("k1");
const keys = createKeyRing({ k1: key.publicKey });
const T0 = 1_800_000_000_000;
const content = { routing: { routes: { "/": [] }, experiments: {} }, variants: {} };

function token(ver: number, iat = T0 / 1000) {
  return signJws(
    {
      pv: PROTOCOL_VERSION,
      site: SITE,
      ver,
      iat,
      exp: iat + BUNDLE_TTL_SECONDS,
      hash: computeBundleHash(content),
      ...content,
    },
    { ...key, typ: BUNDLE_TYP },
  );
}

function setup(opts: { cloudVer?: number; initialVer?: number } = {}) {
  let t = T0;
  let cloud = token(opts.cloudVer ?? 2);
  const fetcher = vi.fn(
    async (): Promise<FetchBundleResult> => ({ status: "ok", token: cloud, etag: null }),
  );
  const store = createMemoryStore({
    site: SITE,
    keys,
    fetcher,
    pollMs: 60_000,
    initialToken: token(opts.initialVer ?? 1),
    now: () => t,
  });
  const tasks: Array<() => Promise<void>> = [];
  const synced = vi.fn(async (_token: string) => {});
  const deps: SyncDeps = {
    env,
    store: () => store,
    replay: createReplayGuard({ now: () => t }),
    throttle: createSyncThrottle(),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    defer: (task) => {
      tasks.push(task);
    },
    onSynced: synced,
  };
  return {
    store,
    fetcher,
    deps,
    synced,
    tasks,
    settle: () => Promise.all(tasks.splice(0).map((f) => f())),
    setCloud: (v: number) => {
      cloud = token(v);
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

let n = 0;
function req(
  body: unknown,
  o: { secret?: string; t?: number; delivery?: string; raw?: string } = {},
): Request {
  const text = o.raw ?? JSON.stringify(body);
  return new Request("http://app.test/api/evolve/sync", {
    method: "POST",
    headers: {
      "evolve-signature": signBody(o.secret ?? SECRET, text, o.t ?? T0 / 1000),
      "evolve-delivery": o.delivery ?? `d-${++n}`,
    },
    body: text,
  });
}
const updated = (ver: number, iat = T0 / 1000) => ({
  pv: 1,
  type: "bundle.updated",
  site: SITE,
  ver,
  iat,
});

describe("POST /api/evolve/sync", () => {
  it("bundle.updated with a newer ver → 202, then pulls, installs and reports the new bundle", async () => {
    const s = setup();
    const res = await handleSync(req(updated(2)), s.deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(s.fetcher).not.toHaveBeenCalled(); // the work happens after the response
    await s.settle();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.store.current()?.ver).toBe(2);
    expect(s.synced).toHaveBeenCalledWith(s.store.token());
  });

  it("a ver the app already has → 202 without a fetch", async () => {
    const s = setup({ initialVer: 3 });
    const res = await handleSync(req(updated(3)), s.deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: false, reason: "current" });
    await s.settle();
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("same ver with a later iat (re-sign) is pulled", async () => {
    const s = setup({ initialVer: 3 });
    const res = await handleSync(req(updated(3, T0 / 1000 + 60)), s.deps);
    expect(await res.json()).toEqual({ accepted: true });
  });

  it("forged, stale and replayed calls never fetch", async () => {
    const s = setup();
    const forged = await handleSync(req(updated(2), { secret: `whsec_${"x".repeat(32)}` }), s.deps);
    expect(forged.status).toBe(401);
    const stale = await handleSync(req(updated(2), { t: T0 / 1000 - 301 }), s.deps);
    expect(stale.status).toBe(401);
    const first = await handleSync(req(updated(2), { delivery: "same" }), s.deps);
    expect(first.status).toBe(202);
    await s.settle();
    s.advance(10_000);
    const replay = await handleSync(req(updated(9), { delivery: "same" }), s.deps);
    expect(replay.status).toBe(409);
    await s.settle();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects other sites, unsupported pv, bad JSON and missing config", async () => {
    const s = setup();
    expect((await handleSync(req({ ...updated(2), site: "site_other00000" }), s.deps)).status).toBe(
      403,
    );
    const pv = await handleSync(req({ ...updated(2), pv: 99 }), s.deps);
    expect(pv.status).toBe(400);
    expect(await pv.json()).toMatchObject({ error: "unsupported_protocol" });
    expect((await handleSync(req(null, { raw: "{" }), s.deps)).status).toBe(400);
    expect((await handleSync(req({ pv: 1, type: "nope" }), s.deps)).status).toBe(400);
    expect((await handleSync(req(updated(2)), { ...s.deps, env: {} })).status).toBe(503);
    await s.settle();
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("ping → 202 with the app's current ver and protocols, no fetch", async () => {
    const s = setup();
    const res = await handleSync(req({ pv: 1, type: "ping" }), s.deps);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, ver: 1, protocol: { supported: [1] } });
    await s.settle();
    expect(s.fetcher).not.toHaveBeenCalled();
  });

  it("at most one refresh per 5 s; a change inside the window is pulled when it ends", async () => {
    const s = setup();
    await handleSync(req(updated(2)), s.deps);
    await s.settle();
    expect(s.store.current()?.ver).toBe(2);
    s.setCloud(3);
    s.advance(1000);
    await handleSync(req(updated(3)), s.deps);
    s.setCloud(4);
    await handleSync(req(updated(4)), s.deps); // joins the waiting refresh
    await s.settle();
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    expect(s.store.current()?.ver).toBe(4);
  });
});
