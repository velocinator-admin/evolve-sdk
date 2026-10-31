import { type KeyRing, parseSecretKey } from "@next-evolve/protocol";
import { trustedKeys } from "../core/keys";
import { fetchBundle } from "./fetch";
import { type BundleStore, createMemoryStore } from "./memory";

type Env = Record<string, string | undefined>;

export type RuntimeOptions = {
  /** Signed bundle written at build time by `evolve pull` (cold-start fallback). */
  buildBundle?: string | null;
  /** Inject a store (tests). */
  store?: BundleStore;
  env?: Env;
};

/** Default cloud URL. The production domain is still open (decision D29), so it must be set for now. */
export const DEFAULT_CLOUD_URL: string | undefined = undefined;

const REGISTRY = Symbol.for("next-evolve.stores");
type Registry = Map<string, BundleStore>;
const registry = (): Registry => {
  const g = globalThis as { [REGISTRY]?: Registry };
  g[REGISTRY] ??= new Map();
  return g[REGISTRY];
};

/**
 * The process-wide bundle store for this site, shared by the proxy and the
 * render path when they run in the same process. Null when the app has no
 * valid secret key (then everything serves control).
 */
export function getBundleStore(
  config: { pollSeconds?: number },
  opts: RuntimeOptions = {},
): BundleStore | null {
  if (opts.store) return opts.store;
  const env = opts.env ?? process.env;
  const secretKey = env.EVOLVE_SECRET_KEY;
  const site = secretKey ? parseSecretKey(secretKey)?.siteId : undefined;
  if (!secretKey || !site) return null;

  const reg = registry();
  const existing = reg.get(site);
  if (existing) {
    if (opts.buildBundle && !existing.token()) existing.load(opts.buildBundle);
    return existing;
  }
  const cloudUrl = env.EVOLVE_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  const store = createMemoryStore({
    site,
    keys: trustedKeys(env),
    pollMs: (config.pollSeconds ?? (env.NODE_ENV === "production" ? 60 : 5)) * 1000,
    initialToken: opts.buildBundle ?? null,
    fetcher: cloudUrl ? (etag) => fetchBundle({ cloudUrl, secretKey, etag }) : undefined,
  });
  reg.set(site, store);
  return store;
}

const identities = new Map<string, { site: string; keys: KeyRing } | null>();

/** This app's site id (from EVOLVE_SECRET_KEY) and trusted public keys. Cached; null without a valid key. */
export function getSiteIdentity(opts: { env?: Env } = {}): { site: string; keys: KeyRing } | null {
  const env = opts.env ?? process.env;
  const cacheKey = [
    env.EVOLVE_SECRET_KEY,
    env.EVOLVE_UNSAFE_TEST_PUBLIC_KEY,
    env.EVOLVE_UNSAFE_ALLOW_TEST_KEY,
    env.NODE_ENV,
  ].join("|");
  if (identities.has(cacheKey)) return identities.get(cacheKey)!;
  const site = env.EVOLVE_SECRET_KEY ? parseSecretKey(env.EVOLVE_SECRET_KEY)?.siteId : undefined;
  const id = site ? { site, keys: trustedKeys(env) } : null;
  identities.set(cacheKey, id);
  return id;
}

/** Test helper: forget all stores. */
export function resetBundleStores(): void {
  registry().clear();
}
