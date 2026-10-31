import { type BundlePayload, bundlePayloadSchema, computeBundleHash } from "./bundle";
import { type JwsFailure, type KeyRing, verifyJws } from "./jws";
import { BUNDLE_TYP } from "./keys";
import { SUPPORTED_PROTOCOLS } from "./version";

/** Allowed clock skew for `iat`, in seconds. */
export const MAX_IAT_SKEW_SECONDS = 300;

export type BundleFailure =
  | JwsFailure
  | "unsupported_pv"
  | "invalid_payload"
  | "wrong_site"
  | "rollback"
  | "iat_in_future"
  | "expired"
  | "hash_mismatch";

export type VerifyBundleResult =
  | { ok: true; payload: BundlePayload }
  | { ok: false; reason: BundleFailure };

export type VerifyBundleOptions = {
  keys: KeyRing;
  /** The site this app's secret key belongs to. */
  site: string;
  /** The bundle currently served, if any (rollback protection). */
  current?: { ver: number; exp: number } | null;
  /** Unix seconds. Defaults to now. */
  now?: number;
  supported?: readonly number[];
};

/**
 * Full acceptance check for a signed bundle (spec §7.3). Run once per new
 * bundle, never per request; per request only `exp` is re-checked.
 */
export function verifyBundle(token: string, opts: VerifyBundleOptions): VerifyBundleResult {
  const jws = verifyJws(token, opts.keys, BUNDLE_TYP);
  if (!jws.ok) return jws;

  const pv = (jws.payload as { pv?: unknown } | null)?.pv;
  if (typeof pv !== "number" || !(opts.supported ?? SUPPORTED_PROTOCOLS).includes(pv)) {
    return { ok: false, reason: "unsupported_pv" };
  }
  const parsed = bundlePayloadSchema.safeParse(jws.payload);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  const b = parsed.data;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (b.site !== opts.site) return { ok: false, reason: "wrong_site" };
  const cur = opts.current;
  if (cur && !(b.ver > cur.ver || (b.ver === cur.ver && b.exp > cur.exp))) {
    return { ok: false, reason: "rollback" };
  }
  if (b.iat > now + MAX_IAT_SKEW_SECONDS) return { ok: false, reason: "iat_in_future" };
  if (now >= b.exp) return { ok: false, reason: "expired" };
  if (b.hash !== computeBundleHash(b)) return { ok: false, reason: "hash_mismatch" };
  return { ok: true, payload: b };
}
