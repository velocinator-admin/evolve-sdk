// POST /api/evolve/sync (spec §7.6): the cloud says "a new bundle exists"; the
// app answers 202 and pulls the signed bundle itself after the response. The
// webhook carries no config, so a forged or replayed call can at most cause
// one extra signed-bundle fetch.
import {
  DELIVERY_HEADER,
  isSupportedProtocol,
  parseSecretKey,
  type ReplayGuard,
  SIGNATURE_HEADER,
  SUPPORTED_PROTOCOLS,
  syncWebhookSchema,
  unsupportedProtocolBody,
  verifyBody,
} from "@next-evolve/protocol";
import { logRateLimited } from "../core/log";
import type { BundleStore } from "../store/memory";
import { firstMessage, sharedReplayGuard } from "./aggregate-route";

type Env = Record<string, string | undefined>;

/** Cache tag on the render-side bundle fetch (spec §7.7). */
export const BUNDLE_TAG = "evolve-bundle";
/** At most one refresh per window. */
export const SYNC_MIN_INTERVAL_MS = 5000;
const MAX_BODY_BYTES = 16 * 1024;

export type SyncThrottle = { last: number; waiting: Promise<void> | null };
export const createSyncThrottle = (): SyncThrottle => ({ last: -Infinity, waiting: null });

const THROTTLE = Symbol.for("next-evolve.sync-throttle");
function sharedThrottle(): SyncThrottle {
  const g = globalThis as { [THROTTLE]?: SyncThrottle };
  g[THROTTLE] ??= createSyncThrottle();
  return g[THROTTLE];
}

export type SyncDeps = {
  env: Env;
  store: () => BundleStore | null;
  /** Runs after the response (`after()` by default). */
  defer?: (task: () => Promise<void>) => void;
  /** Called with the new token once a refresh installed one (persist + revalidate). */
  onSynced?: (token: string) => Promise<void>;
  replay?: ReplayGuard;
  throttle?: SyncThrottle;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const json = (status: number, body: unknown) => Response.json(body, { status });

export async function handleSync(req: Request, deps: SyncDeps): Promise<Response> {
  const secret = deps.env.EVOLVE_WEBHOOK_SECRET;
  const site = parseSecretKey(deps.env.EVOLVE_SECRET_KEY ?? "")?.siteId;
  const store = deps.store();
  if (!secret || !site || !store) return json(503, { error: "not_configured" });

  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  const now = deps.now ?? Date.now;
  const sig = verifyBody(req.headers.get(SIGNATURE_HEADER), body, secret, {
    now: Math.floor(now() / 1000),
  });
  if (!sig.ok) return json(401, { error: "invalid_signature", reason: sig.reason });
  const guard = deps.replay ?? sharedReplayGuard();
  const delivery = req.headers.get(DELIVERY_HEADER);
  if (!delivery || !guard.check(delivery)) return json(409, { error: "replayed" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!isSupportedProtocol((parsed as { pv?: unknown } | null)?.pv)) {
    return json(400, unsupportedProtocolBody());
  }
  const r = syncWebhookSchema.safeParse(parsed);
  if (!r.success) return json(400, { error: "invalid" });

  const current = store.current();
  if (r.data.type === "ping") {
    return json(202, {
      ok: true,
      ver: current?.ver ?? null,
      protocol: { supported: SUPPORTED_PROTOCOLS },
    });
  }
  if (r.data.site !== site) return json(403, { error: "site_mismatch" });
  // The delivery id isn't signed: refuse the same signed message under a new
  // one (T12.5). Pings are exempt: their body is constant, so two in the same
  // second would collide, and a replayed ping changes nothing.
  if (!firstMessage(guard, sig.t, body)) return json(409, { error: "replayed" });
  const newer =
    !current ||
    r.data.ver > current.ver ||
    (r.data.ver === current.ver && r.data.iat > current.iat);
  if (!newer) return json(202, { accepted: false, reason: "current" });

  const work = () => throttledRefresh(store, deps);
  (deps.defer ?? deferAfter)(work);
  return json(202, { accepted: true });
}

/**
 * Refreshes at most once per {@link SYNC_MIN_INTERVAL_MS}. A call inside the
 * window waits for its end (calls that arrive meanwhile share that refresh),
 * so the last change is always pulled.
 */
function throttledRefresh(store: BundleStore, deps: SyncDeps): Promise<void> {
  const t = deps.throttle ?? sharedThrottle();
  if (t.waiting) return t.waiting;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const wait = Math.max(0, t.last + SYNC_MIN_INTERVAL_MS - now());
  const run = async () => {
    if (wait > 0) await sleep(wait);
    t.waiting = null; // later calls start a new window
    t.last = now();
    const before = store.token();
    await store.refresh({ force: true });
    const after = store.token();
    if (after && after !== before) await (deps.onSynced ?? revalidateBundle)(after);
  };
  const p = run().catch((e) => logRateLimited("sync", "sync refresh failed", e));
  t.waiting = wait > 0 ? p : null;
  return p;
}

async function deferAfter(task: () => Promise<void>): Promise<void> {
  try {
    const { after } = await import("next/server");
    after(task);
  } catch {
    void task(); // outside a request scope
  }
}

/** Drops cached render-side bundle fetches (and pages that used them). */
export async function revalidateBundle(): Promise<void> {
  try {
    const { revalidateTag } = await import("next/cache");
    revalidateTag(BUNDLE_TAG, { expire: 0 });
  } catch (e) {
    logRateLimited("sync:revalidate", "revalidateTag failed", e);
  }
}
