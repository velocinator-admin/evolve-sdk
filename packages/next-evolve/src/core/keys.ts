import { createKeyRing, EVOLVE_PUBLIC_KEYS, type KeyRing } from "@next-evolve/protocol";

type Env = Record<string, string | undefined>;

let warned = false;

/**
 * Public keys this app trusts for bundles and preview tokens: Evolve Cloud's
 * production keys, plus an optional test key for local development and the
 * fake cloud.
 *
 * `EVOLVE_UNSAFE_TEST_PUBLIC_KEY=<kid>:<x>` is ignored when
 * NODE_ENV=production, unless `EVOLVE_UNSAFE_ALLOW_TEST_KEY=1` is also set
 * (needed only to run SDK e2e tests against a production build).
 */
export function trustedKeySet(env: Env = process.env): Record<string, string> {
  const keys: Record<string, string> = { ...EVOLVE_PUBLIC_KEYS };
  const test = env.EVOLVE_UNSAFE_TEST_PUBLIC_KEY;
  if (!test) return keys;

  const prod = env.NODE_ENV === "production";
  if (prod && env.EVOLVE_UNSAFE_ALLOW_TEST_KEY !== "1") {
    if (!warned) {
      warned = true;
      console.error("[evolve] EVOLVE_UNSAFE_TEST_PUBLIC_KEY is ignored in production.");
    }
    return keys;
  }
  const m = /^([A-Za-z0-9_.-]{1,64}):([A-Za-z0-9_-]{43})$/.exec(test);
  if (!m) {
    console.error("[evolve] EVOLVE_UNSAFE_TEST_PUBLIC_KEY must be <kid>:<base64url x>; ignored.");
    return keys;
  }
  if (m[1]! in keys) return keys; // never shadow a production kid
  if (prod) console.error("[evolve] UNSAFE: trusting a test signing key in a production build.");
  keys[m[1]!] = m[2]!;
  return keys;
}

export function trustedKeys(env: Env = process.env): KeyRing {
  return createKeyRing(trustedKeySet(env));
}
