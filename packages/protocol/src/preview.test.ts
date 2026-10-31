import { describe, expect, it } from "vitest";
import { createKeyRing } from "./jws";
import { BUNDLE_TYP, PREVIEW_TYP } from "./keys";
import { verifyPreview } from "./preview";
import { generateTestKeyPair, signJws } from "./testing";

const kp = generateTestKeyPair("p1");
const keys = createKeyRing({ p1: kp.publicKey });
const site = "site_ab12cd34ef";
const now = 1_800_000_000;
const token = (payload: object, typ = PREVIEW_TYP) => signJws(payload, { ...kp, typ });

describe("verifyPreview", () => {
  const good = { site, code: "ev_k3j9x2-c1d2e3", exp: now + 3600 };

  it("accepts a valid token", () => {
    expect(verifyPreview(token(good), { keys, site, now })).toMatchObject(good);
  });
  it("rejects expired, other-site, malformed-code and bundle-typed tokens", () => {
    expect(verifyPreview(token({ ...good, exp: now }), { keys, site, now })).toBeNull();
    expect(verifyPreview(token(good), { keys, site: "site_zzzzzzzzzz", now })).toBeNull();
    expect(verifyPreview(token({ ...good, code: "ev_bad" }), { keys, site, now })).toBeNull();
    expect(verifyPreview(token(good, BUNDLE_TYP), { keys, site, now })).toBeNull();
    expect(verifyPreview("garbage", { keys, site, now })).toBeNull();
  });
  it("rejects a token signed by an unknown key", () => {
    const other = generateTestKeyPair("p1");
    expect(
      verifyPreview(signJws(good, { ...other, typ: PREVIEW_TYP }), { keys, site, now }),
    ).toBeNull();
  });
});
