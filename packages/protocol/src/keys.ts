import type { PublicKeySet } from "./jws";

export const BUNDLE_TYP = "evolve-bundle+jws";
export const PREVIEW_TYP = "evolve-preview+jws";

/**
 * Evolve Cloud's production bundle-signing public keys (kid → Ed25519 `x`).
 *
 * Rotation: the next key ships in an SDK release at least 6 months before the
 * cloud starts signing with it. Empty until the production key is generated
 * (backlog T7.1); until then only the test key path verifies.
 */
export const EVOLVE_PUBLIC_KEYS: PublicKeySet = Object.freeze({});
