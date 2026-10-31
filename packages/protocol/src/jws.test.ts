import { describe, expect, it } from "vitest";
import { createKeyRing, verifyJws } from "./jws";
import { generateTestKeyPair, signJws } from "./testing";

// Shared CI runners are noisy; budgets are checked strictly on dev machines.
const SLACK = process.env.CI ? 3 : 1;

const TYP = "evolve-bundle+jws";
const kp = generateTestKeyPair("test-1");
const other = generateTestKeyPair("test-1"); // same kid, different key
const ring = createKeyRing({ [kp.kid]: kp.publicKey });

const b64 = (s: string) => Buffer.from(s).toString("base64url");

describe("verifyJws", () => {
  it("verifies a valid token and returns the payload", () => {
    const token = signJws({ hello: "world" }, { ...kp, typ: TYP });
    const r = verifyJws(token, ring, TYP);
    expect(r).toMatchObject({ ok: true, payload: { hello: "world" }, header: { kid: "test-1" } });
  });

  it("rejects a tampered payload", () => {
    const [h, , s] = signJws({ ver: 1 }, { ...kp, typ: TYP }).split(".");
    const r = verifyJws(`${h}.${b64('{"ver":2}')}.${s}`, ring, TYP);
    expect(r).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token signed by another key with the same kid", () => {
    const token = signJws({ ver: 1 }, { ...other, typ: TYP });
    expect(verifyJws(token, ring, TYP)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an unknown kid", () => {
    const token = signJws({ ver: 1 }, { ...kp, kid: "nope", typ: TYP });
    expect(verifyJws(token, ring, TYP)).toEqual({ ok: false, reason: "unknown_kid" });
  });

  it("rejects a wrong alg (incl. none)", () => {
    const [, p, s] = signJws({ ver: 1 }, { ...kp, typ: TYP }).split(".");
    for (const alg of ["none", "HS256", "RS256"]) {
      const h = b64(JSON.stringify({ alg, kid: kp.kid, typ: TYP }));
      expect(verifyJws(`${h}.${p}.${s}`, ring, TYP)).toEqual({ ok: false, reason: "bad_alg" });
    }
  });

  it("rejects the wrong typ (a preview token is not a bundle)", () => {
    const token = signJws({ ver: 1 }, { ...kp, typ: "evolve-preview+jws" });
    expect(verifyJws(token, ring, TYP)).toEqual({ ok: false, reason: "bad_typ" });
  });

  it("rejects malformed tokens", () => {
    for (const t of ["", "a.b", "a.b.c.d", "!!.@@.##", `${b64("not json")}.${b64("{}")}.AAAA`]) {
      expect(verifyJws(t, ring, TYP)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a validly signed payload that is not JSON", () => {
    const raw = signJws("__raw__:not json", { ...kp, typ: TYP });
    expect(verifyJws(raw, ring, TYP)).toEqual({ ok: false, reason: "bad_payload" });
  });

  it("verifies in < 0.2 ms (median)", () => {
    const token = signJws({ big: "x".repeat(4000) }, { ...kp, typ: TYP });
    for (let i = 0; i < 200; i++) verifyJws(token, ring, TYP);
    const times: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const t0 = performance.now();
      verifyJws(token, ring, TYP);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[1000]).toBeLessThan(0.2 * SLACK);
  });
});
