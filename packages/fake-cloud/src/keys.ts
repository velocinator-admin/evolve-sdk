import { createPrivateKey } from "node:crypto";
import type { TestKeyPair } from "@next-evolve/protocol/testing";

/**
 * TEST KEYPAIR ONLY. Committed on purpose so fixture apps can trust it via
 * `EVOLVE_UNSAFE_TEST_PUBLIC_KEY=${TEST_PUBLIC_KEY_ENV}`. The SDK refuses this
 * variable when NODE_ENV=production. Never use it to sign anything real.
 */
const JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "3T-kMbeP5Or7YJOpiDmkcV5rQi6mWGM2xV5Yu0iyuLI",
  d: "lvdaNylfvFkePdmL0tVOZXM4aXWENZ1ak3y564CnKzY",
} as const;

export const TEST_KEY: TestKeyPair = {
  kid: "fake-cloud-test",
  publicKey: JWK.x,
  privateKey: createPrivateKey({ key: JWK, format: "jwk" }),
};

/** Value for `EVOLVE_UNSAFE_TEST_PUBLIC_KEY`: `<kid>:<x>`. */
export const TEST_PUBLIC_KEY_ENV = `${TEST_KEY.kid}:${TEST_KEY.publicKey}`;

/** A well-formed secret key and webhook secret for the fake site. */
export const TEST_SITE = "site_fakecloud0";
export const TEST_SECRET_KEY = `evk_live_${TEST_SITE}_${"T".repeat(32)}`;
export const TEST_WEBHOOK_SECRET = `whsec_${"W".repeat(32)}`;
