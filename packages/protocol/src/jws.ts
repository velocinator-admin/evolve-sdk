import { createPublicKey, type KeyObject, verify } from "node:crypto";

/** kid → raw Ed25519 public key, base64url (the JWK `x` value). */
export type PublicKeySet = Readonly<Record<string, string>>;
/** Imported, ready-to-use public keys. Build once with {@link createKeyRing}. */
export type KeyRing = ReadonlyMap<string, KeyObject>;

export type JwsHeader = { alg: "EdDSA"; kid: string; typ: string };
export type JwsFailure =
  | "malformed"
  | "bad_alg"
  | "unknown_kid"
  | "bad_typ"
  | "bad_signature"
  | "bad_payload";
export type JwsResult =
  | { ok: true; header: JwsHeader; payload: unknown }
  | { ok: false; reason: JwsFailure };

export function createKeyRing(set: PublicKeySet): KeyRing {
  const ring = new Map<string, KeyObject>();
  for (const [kid, x] of Object.entries(set)) {
    ring.set(kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }));
  }
  return ring;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Verifies a compact EdDSA (Ed25519) JWS synchronously.
 * Checks, in order: shape, header (`alg`, known `kid`, `typ`), signature, JSON payload.
 */
export function verifyJws(token: string, keys: KeyRing, typ: string): JwsResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  if (!B64URL.test(h) || !B64URL.test(p) || !B64URL.test(s))
    return { ok: false, reason: "malformed" };

  let header: Partial<JwsHeader>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!header || typeof header !== "object") return { ok: false, reason: "malformed" };
  if (header.alg !== "EdDSA") return { ok: false, reason: "bad_alg" };
  const key = typeof header.kid === "string" ? keys.get(header.kid) : undefined;
  if (!key) return { ok: false, reason: "unknown_kid" };
  if (header.typ !== typ) return { ok: false, reason: "bad_typ" };

  const signature = Buffer.from(s, "base64url");
  if (!verify(null, Buffer.from(`${h}.${p}`), key, signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return { ok: true, header: header as JwsHeader, payload };
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
}
