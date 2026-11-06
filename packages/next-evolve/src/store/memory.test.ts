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
import { createMemoryStore, ERROR_RETRY_MS, STUCK_FETCH_MS } from "./memory";

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
  const all: Array<(r: FetchBundleResult) => void> = [];
  const fetcher = vi.fn(
    (_etag: string | null, _o?: { cloud?: boolean }) =>
      new Promise<FetchBundleResult>((r) => {
        replies.push(r);
        all.push(r);
      }),
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
    /** Settles the i-th fetch ever started (out of order). */
    replies_settle: (i: number, r: FetchBundleResult) => all[i]!(r),
    errors: vi.spyOn(console, "error").mockImplementation(() => {}),
    infos: vi.spyOn(console, "info").mockImplementation(() => {}),
  };
}

describe("memory bundle store", () => {
  it("a new site's 404 no_bundle logs what it means at info level, not a failure", async () => {
    const s = setup();
    s.store.peek();
    await s.reply({ status: "error", code: 404, message: '{"error":"no_bundle"}' });
    // Info, not stderr: hosts like Vercel show stderr lines as errors.
    expect(s.infos).toHaveBeenCalledWith(
      "[evolve] no bundle yet (no experiment has started): serving control",
    );
    expect(s.errors).not.toHaveBeenCalled();
    expect(s.store.peek()).toBeNull();
  });

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
    const s = setup({ pollMs: 1_000 });
    s.store.peek();
    s.advance(STUCK_FETCH_MS - 1); // due again, but the first fetch is still live
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

describe("refresh({ force })", () => {
  it("waits for a fetch already in flight, then fetches again", async () => {
    const s = setup();
    const first = s.store.refresh();
    const forced = s.store.refresh({ force: true });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    await s.reply({ status: "not_modified" });
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    await s.reply({ status: "ok", token: token({ ver: 7 }), etag: null });
    await forced;
    expect(s.store.current()?.ver).toBe(7);
  });
});

// T19.5 drill: idle Vercel instances kept an old bundle for minutes.
describe("stale instances (T19.5)", () => {
  it("refresh({ cloud: true }) tells the fetcher to ask the cloud now", async () => {
    const s = setup();
    void s.store.refresh({ cloud: true });
    expect(s.fetcher).toHaveBeenLastCalledWith(null, { cloud: true });
    await s.reply({ status: "not_modified" });
    void s.store.refresh();
    expect(s.fetcher).toHaveBeenLastCalledWith(null);
  });

  it("a fetch that never settles (frozen with its instance) stops blocking refreshes after STUCK_FETCH_MS", async () => {
    const s = setup();
    s.store.peek(); // background poll; its promise never settles
    s.advance(STUCK_FETCH_MS - 1);
    void s.store.refresh();
    expect(s.fetcher).toHaveBeenCalledTimes(1); // still shares it
    s.advance(1);
    const fresh = s.store.refresh();
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    s.advance(1);
    s.store.peek(); // the new fetch is the one in flight now
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    s.replies_settle(1, { status: "ok", token: token({ ver: 4 }), etag: null });
    await fresh;
    expect(s.store.current()?.ver).toBe(4);
    // The old fetch settling late can't replace the newer bundle (rollback check).
    s.replies_settle(0, { status: "ok", token: token({ ver: 2 }), etag: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.store.current()?.ver).toBe(4);
  });

  it(`a failed fetch (network/5xx) is retried after ${ERROR_RETRY_MS} ms, not a full poll`, async () => {
    const s = setup({ initial: token({ ver: 3 }) });
    s.store.peek();
    await s.reply({ status: "error", code: "network" });
    s.advance(ERROR_RETRY_MS - 1);
    s.store.peek();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    s.advance(1);
    s.store.peek();
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    // 401 (revoked key) and 404 (no bundle yet) keep the normal poll.
    await s.reply({ status: "error", code: 401 });
    s.advance(ERROR_RETRY_MS);
    s.store.peek();
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("deleted site (410 site_deleted)", () => {
  const gone: FetchBundleResult = {
    status: "error",
    code: 410,
    message: '{"error":"site_deleted"}',
  };

  it("drops the cached bundle at once: control, not the 14-day cache", async () => {
    const s = setup({ initial: token({ ver: 3 }) });
    expect(s.store.peek()?.ver).toBe(3);
    await s.reply(gone);
    expect(s.store.peek()).toBeNull();
    expect(s.store.token()).toBeNull();
    expect(s.errors).toHaveBeenCalledWith(
      "[evolve] this site was deleted in Evolve Cloud: serving control",
    );
  });

  it("then rejects the old bundle from another source (build bundle, disk, Global Config)", async () => {
    const old = token({ ver: 3 });
    const s = setup({ initial: old });
    s.store.peek();
    await s.reply(gone);
    expect(s.store.load(old)).toBe(false);
    expect(s.store.load(token({ ver: 2 }))).toBe(false);
    expect(s.store.peek()).toBeNull();
  });

  it("a newer signed bundle from the cloud is still accepted (the cloud is the authority)", async () => {
    const s = setup({ initial: token({ ver: 3 }) });
    s.store.peek();
    await s.reply(gone);
    s.advance(70_000);
    s.store.peek();
    await s.reply({ status: "ok", token: token({ ver: 4 }), etag: null });
    expect(s.store.peek()?.ver).toBe(4);
  });

  it.each([
    ["401 invalid_key (e.g. a revoked key during rotation)", 401, '{"error":"invalid_key"}'],
    ["404", 404, '{"error":"not_found"}'],
    ["410 without site_deleted", 410, "gone"],
  ])("a %s keeps the cached bundle", async (_, code, message) => {
    const s = setup({ initial: token({ ver: 3 }) });
    for (let i = 0; i < 5; i++) {
      s.store.peek();
      await s.reply({ status: "error", code, message });
      s.advance(70_000);
    }
    expect(s.store.peek()?.ver).toBe(3);
  });
});
