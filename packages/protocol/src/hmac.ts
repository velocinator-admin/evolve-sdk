import { createHmac, timingSafeEqual } from "node:crypto";

/** Headers on every signed cloud ↔ app call (sync webhook, aggregate request and response). */
export const SIGNATURE_HEADER = "evolve-signature";
export const DELIVERY_HEADER = "evolve-delivery";
/** Max |now − t| for a signed call, in seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const hmacHex = (secret: string, t: number, body: string) =>
  createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

/** `Evolve-Signature` value for `body`: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. */
export function signBody(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmacHex(secret, t, body)}`;
}

export type SignatureResult =
  | { ok: true; t: number }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "bad_signature" };

/** Verifies an `Evolve-Signature` header against the raw body (constant-time compare). */
export function verifyBody(
  header: string | null | undefined,
  body: string,
  secret: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): SignatureResult {
  if (header == null) return { ok: false, reason: "missing" };
  let t: number | undefined;
  const sigs: Buffer[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) sigs.push(Buffer.from(v, "hex"));
    else return { ok: false, reason: "malformed" };
  }
  if (t === undefined || sigs.length === 0) return { ok: false, reason: "malformed" };

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) {
    return { ok: false, reason: "stale" };
  }
  const expected = Buffer.from(hmacHex(secret, t, body), "hex");
  // Check every candidate so timing doesn't reveal which one matched.
  let match = false;
  for (const s of sigs) match = timingSafeEqual(s, expected) || match;
  return match ? { ok: true, t } : { ok: false, reason: "bad_signature" };
}

export type ReplayGuard = {
  /** True the first time `id` is seen within the window (and records it); false on replay. */
  check(id: string): boolean;
  size(): number;
};

/** In-memory delivery-id LRU (default: 10-minute window, 10k ids). */
export function createReplayGuard(
  opts: { ttlMs?: number; max?: number; now?: () => number } = {},
): ReplayGuard {
  const ttl = opts.ttlMs ?? 600_000;
  const max = opts.max ?? 10_000;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, number>(); // id → expiry; insertion order = age

  return {
    check(id) {
      if (!id) return false;
      const t = now();
      for (const [k, exp] of seen) {
        if (exp > t && seen.size <= max) break;
        seen.delete(k);
      }
      const exp = seen.get(id);
      if (exp !== undefined && exp > t) return false;
      seen.delete(id);
      seen.set(id, t + ttl);
      while (seen.size > max) seen.delete(seen.keys().next().value!);
      return true;
    },
    size: () => seen.size,
  };
}
