import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { canonicalJson } from "./canonical";

/**
 * TEST ONLY. Signing helpers for the fake cloud and tests. Production bundles
 * are signed by Evolve Cloud with keys that never leave it.
 */
export type TestKeyPair = { kid: string; publicKey: string; privateKey: KeyObject };

export function generateTestKeyPair(kid = "test"): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { kid, publicKey: jwk.x!, privateKey };
}

/**
 * Signs `payload` (canonical JSON) as a compact EdDSA JWS. A string payload
 * starting with `__raw__:` is used verbatim (for malformed-payload tests).
 */
export function signJws(
  payload: unknown,
  opts: { kid: string; typ: string; privateKey: KeyObject },
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: opts.kid, typ: opts.typ }),
  ).toString("base64url");
  const raw =
    typeof payload === "string" && payload.startsWith("__raw__:")
      ? payload.slice("__raw__:".length)
      : canonicalJson(payload);
  const body = Buffer.from(raw).toString("base64url");
  const sig = sign(null, Buffer.from(`${header}.${body}`), opts.privateKey).toString("base64url");
  return `${header}.${body}.${sig}`;
}
