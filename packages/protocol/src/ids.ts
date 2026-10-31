import { randomBytes } from "node:crypto";

/** Experiment and variant ids: 6 chars of `[a-z0-9]`. */
export const ID_RE = /^[a-z0-9]{6}$/;
/** Anonymous visitor id: 16 random bytes, base64url (22 chars). */
export const ANON_ID_RE = /^[A-Za-z0-9_-]{22}$/;
/** Site id: `site_` + 10 chars of `[a-z0-9]`. */
export const SITE_ID_RE = /^site_[a-z0-9]{10}$/;
/** Server-only site key: `evk_live_<siteId>_<32 base62>`. */
export const SECRET_KEY_RE = /^evk_live_(site_[a-z0-9]{10})_[A-Za-z0-9]{32}$/;
/** Per-site webhook secret: `whsec_` + 32 base62. */
export const WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9]{32}$/;
/** Aggregate request id (idempotency key): `agr_` + 24 chars of `[a-z0-9]`. */
export const REQUEST_ID_RE = /^agr_[a-z0-9]{24}$/;
/** Region id used in `<Optimizable id>`. Unique per site. */
export const REGION_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Goal key in `evolve.goals.ts`. */
export const GOAL_KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;

const BASE36 = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform random string over `alphabet` (rejection sampling, no modulo bias). */
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const newId = (): string => randomString(BASE36, 6);
export const newAnonId = (): string => randomBytes(16).toString("base64url");
export const newSiteId = (): string => `site_${randomString(BASE36, 10)}`;
export const newRequestId = (): string => `agr_${randomString(BASE36, 24)}`;
export const newWebhookSecret = (): string => `whsec_${randomString(BASE62, 32)}`;
export const newSecretKey = (siteId: string): string =>
  `evk_live_${siteId}_${randomString(BASE62, 32)}`;

export const isId = (s: string): boolean => ID_RE.test(s);
export const isAnonId = (s: string): boolean => ANON_ID_RE.test(s);

/** Returns the site id embedded in a secret key, or null if the key is malformed. */
export function parseSecretKey(key: string): { siteId: string } | null {
  const m = SECRET_KEY_RE.exec(key);
  return m ? { siteId: m[1]! } : null;
}
