import {
  BUNDLE_TTL_SECONDS,
  BUNDLE_TYP,
  computeBundleHash,
  createKeyRing,
  PROTOCOL_VERSION,
} from "@next-evolve/protocol";
import { generateTestKeyPair, signJws } from "@next-evolve/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import type { FetchBundleResult } from "./fetch";
import { createMemoryStore } from "./memory";

const SITE = "site_memstore00";
const key = generateTestKeyPair("k1");
const keys = createKeyRing({ k1: key.publicKey });
const T0 = 1_800_000_000_000;

const content = { routing: { routes: { "/": [] }, experiments: {} }, variants: {} };
function token(o: { ver: number; iat?: number; exp?: number; site?: string; pv?: number }) {
  const iat = o.iat ?? T0 / 1000;
  return signJws(
    {
      pv: o.pv ?? PROTOCOL_VERSION,
      site: o.site ?? SITE,
      ver: o.ver,
      iat,
      exp: o.exp ?? iat + BUNDLE_TTL_SECONDS,
      hash: computeBundleHash(content),
      ...content,
    },
    { ...key, typ: BUNDLE_TYP },
  );
}

function setup(opts: { initial?: string; pollMs?: number; random?: number } = {}) {
  let t = T0;
  const replies: Array<(r: FetchBundleResult) => void> = [];
  const fetcher = vi.fn(
    (_etag: string | null) => new Promise<FetchBundleResult>((r) => replies.push(r)),
  );
  const store = createMemoryStore({
    site: SITE,
    keys,
    fetcher,
    pollMs: opts.pollMs ?? 60_000,
    initialToken: opts.initial ?? null,
    now: () => t,
    random: () => opts.random ?? 0.5,
  });
  const reply = async (r: FetchBundleResult) => {
    replies.shift()!(r);
    await store.refresh(); // settles once the in-flight fetch finished
  };
  return {
    store,
    fetcher,
    reply,
    advance: (ms: number) => (t += ms),
    errors: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

describe("memory bundle store", () => {
  it("never blocks: peek returns at once while the first fetch is pending", async () => {
    const s = setup();
    const waited: Promise<unknown>[] = [];
    expect(s.store.peek((p) => waited.push(p))).toBeNull();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(waited).toHaveLength(1); // handed to waitUntil
    await s.reply({ status: "ok", token: token({ ver: 1 }), etag: null });
    expect(s.store.peek()?.ver).toBe(1);
  });

  it("keeps one fetch in flight", () => {
    const s = setup();
    s.store.peek();
    s.advance(120_000);
    s.store.peek();
    void s.store.refresh();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });

  it("polls at pollMs with ±10% jitter and sends the ETag", async () => {
    for (const [random, due] of [
      [0, 54_000],
      [1, 66_000],
    ] as const) {
      const s = setup({ random });
      s.store.peek();
      await s.reply({ status: "ok", token: token({ ver: 1 }), etag: null });
      s.advance(due - 1);
      s.store.peek();
      expect(s.fetcher).toHaveBeenCalledTimes(1);
      s.advance(1);
      s.store.peek();
      expect(s.fetcher).toHaveBeenCalledTimes(2);
      expect(s.fetcher).toHaveBeenLastCalledWith(`"1.${T0 / 1000}"`);
    }
  });

  it("keeps the current bundle on 304 and on errors", async () => {
    const s = setup({ initial: token({ ver: 3 }) });
    s.store.peek();
    await s.reply({ status: "not_modified" });
    expect(s.store.peek()?.ver).toBe(3);
    s.advance(70_000);
    s.store.peek();
    await s.reply({ status: "error", code: 503 });
    expect(s.store.peek()?.ver).toBe(3);
  });

  it.each([
    ["rollback (older ver)", { ver: 1 }],
    ["same ver, not a later exp", { ver: 2 }],
    ["another site's bundle", { ver: 9, site: "site_othersite0" }],
    ["an unsupported pv", { ver: 9, pv: 99 }],
    ["an expired bundle", { ver: 9, iat: T0 / 1000 - 20 * 86_400 }],
  ])("rejects %s and keeps the current one", (_, o) => {
    const s = setup({ initial: token({ ver: 2 }) });
    expect(s.store.load(token(o))).toBe(false);
    expect(s.store.peek()?.ver).toBe(2);
  });

  it("accepts a re-sign (same ver, later exp)", () => {
    const s = setup({ initial: token({ ver: 2 }) });
    s.advance(86_400_000); // the daily re-sign, a day later
    expect(s.store.load(token({ ver: 2, iat: T0 / 1000 + 86_400 }))).toBe(true);
    expect(s.store.peek()?.iat).toBe(T0 / 1000 + 86_400);
  });

  it("drops an expired bundle on peek (control) until a fresh one arrives", async () => {
    const s = setup({ initial: token({ ver: 1, exp: T0 / 1000 + 100 }) });
    expect(s.store.peek()?.ver).toBe(1);
    await s.reply({ status: "error", code: "network" });
    s.advance(100_000);
    expect(s.store.peek()).toBeNull();
    expect(s.store.token()).toBeNull();
    await s.reply({ status: "ok", token: token({ ver: 2, iat: T0 / 1000 + 100 }), etag: null });
    expect(s.store.peek()?.ver).toBe(2);
  });
});
