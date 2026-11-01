import type { PublicKeySet } from "./jws";

export const BUNDLE_TYP = "evolve-bundle+jws";
export const PREVIEW_TYP = "evolve-preview+jws";

/**
 * Evolve Cloud's production bundle-signing public keys (kid → Ed25519 `x`).
 *
 * Rotation: the next key ships in an SDK release at least 6 months before the
 * cloud starts signing with it.
 */
export const EVOLVE_PUBLIC_KEYS: PublicKeySet = Object.freeze({
  // Generated 2026-10-31 (T7.1). Private half: BUNDLE_SIGNING_KEY in Evolve Cloud's env only.
  "evolve-2026-10": "qxgKP8rZeLPunIweXAPd1VLQccUzj5xtoJ26wfgCn0Q",
});
