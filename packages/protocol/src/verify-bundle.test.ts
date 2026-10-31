import { describe, expect, it } from "vitest";
import { sampleBundle } from "../test/samples";
import { type BundlePayload, computeBundleHash } from "./bundle";
import { createKeyRing } from "./jws";
import { BUNDLE_TYP } from "./keys";
import { generateTestKeyPair, signJws } from "./testing";
import { verifyBundle } from "./verify-bundle";

const kp = generateTestKeyPair("t1");
const keys = createKeyRing({ t1: kp.publicKey });
const site = "site_ab12cd34ef";

function signed(b: BundlePayload = sampleBundle()) {
  return signJws({ ...b, hash: computeBundleHash(b) }, { ...kp, typ: BUNDLE_TYP });
}
const now = sampleBundle().iat + 60;

describe("verifyBundle", () => {
  it("accepts a valid bundle", () => {
    const r = verifyBundle(signed(), { keys, site, now });
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload.ver).toBe(3);
  });

  it("rejects a bad signature", () => {
    const t = signed();
    const r = verifyBundle(`${t.slice(0, -4)}AAAA`, { keys, site, now });
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a bundle for another site", () => {
    const r = verifyBundle(signed(), { keys, site: "site_zzzzzzzzzz", now });
    expect(r).toEqual({ ok: false, reason: "wrong_site" });
  });

  it("rejects rollback; accepts a re-sign of the same ver with a later exp", () => {
    const t = signed();
    const b = sampleBundle();
    expect(verifyBundle(t, { keys, site, now, current: { ver: 4, exp: b.exp } })).toEqual({
      ok: false,
      reason: "rollback",
    });
    expect(verifyBundle(t, { keys, site, now, current: { ver: 3, exp: b.exp } })).toEqual({
      ok: false,
      reason: "rollback",
    });
    expect(verifyBundle(t, { keys, site, now, current: { ver: 3, exp: b.exp - 86_400 } }).ok).toBe(
      true,
    );
    expect(verifyBundle(t, { keys, site, now, current: { ver: 2, exp: b.exp + 999 } }).ok).toBe(
      true,
    );
  });

  it("rejects iat in the future beyond 5 minutes of skew", () => {
    const b = sampleBundle();
    expect(verifyBundle(signed(), { keys, site, now: b.iat - 299 }).ok).toBe(true);
    expect(verifyBundle(signed(), { keys, site, now: b.iat - 301 })).toEqual({
      ok: false,
      reason: "iat_in_future",
    });
  });

  it("rejects an expired bundle", () => {
    const b = sampleBundle();
    expect(verifyBundle(signed(), { keys, site, now: b.exp })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects an unsupported pv before schema validation", () => {
    const b = { ...sampleBundle(), pv: 2, routing: "a v2 shape" } as unknown as BundlePayload;
    const t = signJws(b, { ...kp, typ: BUNDLE_TYP });
    expect(verifyBundle(t, { keys, site, now })).toEqual({ ok: false, reason: "unsupported_pv" });
  });

  it("rejects an invalid payload", () => {
    const b = sampleBundle();
    b.routing.experiments.k3j9x2!.control = "zzzzzz";
    expect(verifyBundle(signJws(b, { ...kp, typ: BUNDLE_TYP }), { keys, site, now })).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });

  it("rejects a hash that does not match the content", () => {
    const b = { ...sampleBundle(), hash: "0".repeat(64) };
    expect(verifyBundle(signJws(b, { ...kp, typ: BUNDLE_TYP }), { keys, site, now })).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
  });
});
