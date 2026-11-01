import { type BundlePayload, type KeyRing, verifyBundle } from "@next-evolve/protocol";
import { logRateLimited } from "../core/log";
import type { FetchBundleResult } from "./fetch";

export type BundleStore = {
  /**
   * Synchronous read for the request path: the current verified, unexpired
   * bundle or null. May start a background refresh, handed to `waitUntil`.
   */
  peek(waitUntil?: (p: Promise<unknown>) => void): BundlePayload | null;
  /** Verifies and installs a token (build bundle, disk, sync route). Returns whether it was accepted. */
  load(token: string): boolean;
  /** Fetches now (one in flight). Resolves once done. */
  refresh(): Promise<void>;
  /** The current bundle without side effects (no refresh; expiry not applied). */
  current(): BundlePayload | null;
  /** Raw token of the current bundle (for persistence). */
  token(): string | null;
};

export type MemoryStoreOptions = {
  site: string;
  keys: KeyRing;
  /** Fetches from the cloud. Omit for a static store (build bundle only). */
  fetcher?: (etag: string | null) => Promise<FetchBundleResult>;
  pollMs: number;
  initialToken?: string | null;
  now?: () => number;
  random?: () => number;
};

/**
 * In-memory bundle store with stale-while-revalidate polling (spec §7.5):
 * never blocks a request, one fetch in flight, ±10% jitter.
 */
export function createMemoryStore(opts: MemoryStoreOptions): BundleStore {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  let current: BundlePayload | null = null;
  let currentToken: string | null = null;
  let etag: string | null = null;
  let nextCheck = 0;
  let inflight: Promise<void> | null = null;

  const schedule = () => {
    nextCheck = now() + opts.pollMs * (0.9 + 0.2 * random());
  };

  function load(token: string): boolean {
    const r = verifyBundle(token, {
      keys: opts.keys,
      site: opts.site,
      current: current ? { ver: current.ver, exp: current.exp } : null,
      now: Math.floor(now() / 1000),
    });
    if (!r.ok) {
      if (r.reason !== "rollback")
        logRateLimited(`bundle:${r.reason}`, `bundle rejected: ${r.reason}`);
      return false;
    }
    current = r.payload;
    currentToken = token;
    etag = `"${r.payload.ver}.${r.payload.iat}"`;
    return true;
  }

  function refresh(): Promise<void> {
    if (!opts.fetcher) return Promise.resolve();
    if (inflight) return inflight;
    schedule();
    inflight = opts
      .fetcher(etag)
      .then((res) => {
        if (res.status === "ok") load(res.token);
        else if (res.status === "error") {
          logRateLimited(`fetch:${res.code}`, `bundle fetch failed (${res.code})`, res.message);
        }
      })
      .catch((e) => logRateLimited("fetch:throw", "bundle fetch failed", e))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  if (opts.initialToken) load(opts.initialToken);

  return {
    peek(waitUntil) {
      if (current && now() >= current.exp * 1000) {
        current = null; // expired → control until a fresh bundle arrives
        currentToken = null;
      }
      if (opts.fetcher && !inflight && now() >= nextCheck) {
        const p = refresh();
        waitUntil?.(p);
      }
      return current;
    },
    load,
    refresh,
    current: () => current,
    token: () => currentToken,
  };
}
