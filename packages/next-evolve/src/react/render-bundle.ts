import type { BundlePayload } from "@next-evolve/protocol";
import { BUNDLE_TAG } from "../server/sync-route";
import type { BundleStore } from "../store/memory";
import { DEFAULT_CLOUD_URL, getBundleStore } from "../store/runtime";

type Env = Record<string, string | undefined>;

/**
 * At most one `fresh` pull per instance per window. A code the bundle doesn't
 * know can be forged (with `cdnRouting` the variant code comes from a cookie
 * the visitor controls), so unknown codes must not turn into one cloud fetch
 * each; collect's refresher uses the same window. Calls inside the window
 * share the pull in flight, then use the bundle the instance has.
 */
export const FRESH_MIN_INTERVAL_MS = 5_000;
type FreshState = WeakMap<BundleStore, { last: number; inflight: Promise<void> | null }>;
// Process-wide, like the stores themselves: Next may bundle this module once per route.
const FRESH = Symbol.for("next-evolve.fresh-limit");
function freshStates(): FreshState {
  const g = globalThis as { [FRESH]?: FreshState };
  g[FRESH] ??= new WeakMap();
  return g[FRESH];
}

function limitedRefresh(store: BundleStore, now: () => number): Promise<void> {
  const freshState = freshStates();
  let s = freshState.get(store);
  if (!s) {
    s = { last: -Infinity, inflight: null };
    freshState.set(store, s);
  }
  if (s.inflight) return s.inflight;
  if (now() - s.last < FRESH_MIN_INTERVAL_MS) return Promise.resolve();
  s.last = now();
  const state = s;
  state.inflight = store
    .refresh({ force: true })
    .catch(() => {})
    .finally(() => {
      state.inflight = null;
    });
  return state.inflight;
}

/**
 * Bundle for rendering (spec §7.7). Warm: the process-wide store (shared with
 * the proxy where they run in one process). Cold (empty store, e.g. a fresh
 * serverless render function): `GET /v1/bundle` through Next's data cache,
 * tagged `evolve-bundle`, so instances share it and the sync route's
 * `revalidateTag` drops it. `fresh` pulls uncached, for a variant code the
 * cached bundle doesn't know yet (a new or preview-only variant).
 */
export async function getRenderBundle(
  opts: { fresh?: boolean; env?: Env; now?: () => number } = {},
): Promise<BundlePayload | null> {
  const env = opts.env ?? process.env;
  const store = getBundleStore({}, { env });
  if (!store) return null;
  if (opts.fresh) {
    await limitedRefresh(store, opts.now ?? Date.now);
    return store.peek();
  }
  const warm = store.peek();
  if (warm) return warm;
  const token = await taggedFetch(env);
  if (token) store.load(token);
  return store.peek();
}

async function taggedFetch(env: Env): Promise<string | null> {
  const cloudUrl = env.EVOLVE_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  const key = env.EVOLVE_SECRET_KEY;
  if (!cloudUrl || !key) return null;
  try {
    const res = await fetch(new URL("/v1/bundle", cloudUrl), {
      headers: { authorization: `Bearer ${key}` },
      cache: "force-cache",
      next: { tags: [BUNDLE_TAG] },
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}
