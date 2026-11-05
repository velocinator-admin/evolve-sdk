import type { BundlePayload } from "@next-evolve/protocol";
import { BUNDLE_TAG } from "../server/sync-route";
import { ON_DEMAND_MIN_INTERVAL_MS, onDemand } from "../store/on-demand";
import { DEFAULT_CLOUD_URL, getBundleStore } from "../store/runtime";

type Env = Record<string, string | undefined>;

/**
 * At most one `fresh` pull per instance per window. A code the bundle doesn't
 * know can be forged (with `cdnRouting` the variant code comes from a cookie
 * the visitor controls), so unknown codes must not turn into one cloud fetch
 * each. The window is shared with collect and the proxy (`onDemand`). Calls
 * inside it share the pull in flight, then use the bundle the instance has.
 */
export const FRESH_MIN_INTERVAL_MS = ON_DEMAND_MIN_INTERVAL_MS;

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
    await onDemand(store, opts.now ? { now: opts.now } : undefined).nowOrSkip();
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
