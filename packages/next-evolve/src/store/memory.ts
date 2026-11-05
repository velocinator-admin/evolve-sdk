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
  /**
   * Fetches now (one in flight). Resolves once done. `force`: a fetch already
   * in flight may predate a publish, so wait for it and fetch again.
   */
  refresh(opts?: RefreshOptions): Promise<void>;
  /** The current bundle without side effects (no refresh; expiry not applied). */
  current(): BundlePayload | null;
  /** Raw token of the current bundle (for persistence). */
  token(): string | null;
};

export type RefreshOptions = {
  /** A fetch already in flight may predate a publish: wait for it and fetch again. */
  force?: boolean;
  /** Ask the cloud now, not only a cache in front of it (Global Config). For on-demand refreshes. */
  cloud?: boolean;
};

/**
 * A fetch in flight longer than this is treated as lost: on serverless an
 * instance can be frozen with a background fetch it didn't hand to
 * `waitUntil`, and that promise may never settle. (Fetches time out at 5 s.)
 */
export const STUCK_FETCH_MS = 15_000;
/** After a network or 5xx failure, check again this soon (capped at the poll interval). */
export const ERROR_RETRY_MS = 10_000;

export type MemoryStoreOptions = {
  site: string;
  keys: KeyRing;
  /** Fetches from the cloud. Omit for a static store (build bundle only). */
  fetcher?: (etag: string | null, opts?: { cloud?: boolean }) => Promise<FetchBundleResult>;
  pollMs: number;
  initialToken?: string | null;
  now?: () => number;
  random?: () => number;
  /** Called with each token accepted after creation (persistence). */
  onAccept?: (token: string) => void;
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
  let inflightAt = 0;
  const live = () => inflight !== null && now() - inflightAt < STUCK_FETCH_MS;

  const schedule = () => {
    nextCheck = now() + opts.pollMs * (0.9 + 0.2 * random());
  };

  const retrySoon = () => {
    nextCheck = Math.min(nextCheck, now() + Math.min(opts.pollMs, ERROR_RETRY_MS));
  };

  let ready = false;
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
    if (ready) opts.onAccept?.(token);
    return true;
  }

  function refresh(o: RefreshOptions = {}): Promise<void> {
    if (!opts.fetcher) return Promise.resolve();
    if (inflight && live())
      return o.force ? inflight.then(() => refresh({ cloud: o.cloud })) : inflight;
    schedule();
    const f = opts.fetcher;
    const p: Promise<void> = (o.cloud ? f(etag, { cloud: true }) : f(etag))
      .then((res) => {
        if (res.status === "ok") load(res.token);
        else if (res.status === "error" && res.code === 404 && res.message?.includes("no_bundle")) {
          // A new site before its first started experiment: normal, so say what it means.
          logRateLimited(
            "fetch:no_bundle",
            "no bundle yet (no experiment has started): serving control",
            undefined,
            3_600_000,
            "info",
          );
        } else if (res.status === "error") {
          logRateLimited(`fetch:${res.code}`, `bundle fetch failed (${res.code})`, res.message);
          // A timeout or outage shouldn't leave the instance a whole poll behind.
          if (res.code === "network" || res.code >= 500) retrySoon();
        }
      })
      .catch((e) => {
        logRateLimited("fetch:throw", "bundle fetch failed", e);
        retrySoon();
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    inflightAt = now();
    return p;
  }

  if (opts.initialToken) load(opts.initialToken);
  ready = true;

  return {
    peek(waitUntil) {
      if (current && now() >= current.exp * 1000) {
        current = null; // expired → control until a fresh bundle arrives
        currentToken = null;
      }
      if (opts.fetcher && !live() && now() >= nextCheck) {
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
