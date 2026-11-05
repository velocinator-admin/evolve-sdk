// On-demand bundle refresh (T19.5). An instance that sees an experiment or
// variant its bundle doesn't know (a beacon, a cookie, a variant code) may be
// stale, so it asks the cloud right away instead of waiting for its poll. The
// id can also be forged, so every such trigger in one instance shares one
// budget: at most one cloud fetch per ON_DEMAND_MIN_INTERVAL_MS.
import type { BundleStore } from "./memory";

export const ON_DEMAND_MIN_INTERVAL_MS = 5_000;

export type RefreshLimiter = {
  /** Shares the fetch in flight; else fetches if the window allows; else resolves at once. For the request path. */
  nowOrSkip(): Promise<void>;
  /**
   * Shares the fetch in flight; else fetches in the next free slot (waits up to
   * the window). For callers off the visitor's path (collect) that would
   * otherwise drop data. Callers re-check and may call again once.
   */
  soon(): Promise<void>;
};

export function createRefreshLimiter(
  refresh: () => Promise<void>,
  opts: {
    minIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): RefreshLimiter {
  const min = opts.minIntervalMs ?? ON_DEMAND_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = -Infinity;
  let inflight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const start = (): Promise<void> => {
    last = now();
    const p = refresh()
      .catch(() => {})
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
    return p;
  };
  const nowOrSkip = (): Promise<void> => {
    if (inflight) return inflight;
    if (now() - last < min) return Promise.resolve();
    return start();
  };
  const soon = (): Promise<void> => {
    if (inflight) return inflight;
    if (queued) return queued;
    const wait = last + min - now();
    if (wait <= 0) return start();
    queued = sleep(wait).then(() => {
      queued = null;
      return soon(); // someone may have fetched meanwhile: re-apply the rules
    });
    return queued;
  };
  return { nowOrSkip, soon };
}

// Process-wide, like the stores: Next may bundle a module once per route, and
// the proxy, render path and collect must share one budget per store.
const KEY = Symbol.for("next-evolve.on-demand");
type Limiters = WeakMap<BundleStore, RefreshLimiter>;

/** The store's shared on-demand limiter. Its fetches ask the cloud (not only Global Config). */
export function onDemand(
  store: BundleStore,
  /** Clock for the store's limiter, applied when it's created (tests). */
  opts?: { now?: () => number },
): RefreshLimiter {
  const g = globalThis as { [KEY]?: Limiters };
  g[KEY] ??= new WeakMap();
  let l = g[KEY].get(store);
  if (!l) {
    l = createRefreshLimiter(() => store.refresh({ force: true, cloud: true }), opts);
    g[KEY].set(store, l);
  }
  return l;
}
