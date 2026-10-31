import { describe, expect, it } from "vitest";
import { createReplayGuard, signBody, verifyBody } from "./hmac";

const secret = "whsec_0123456789abcdefghijABCDEFGHIJKL";
const body = '{"pv":1,"type":"ping"}';
const t = 1_790_000_000;

describe("hmac signatures", () => {
  it("signs as t=…,v1=<hex> and verifies", () => {
    const h = signBody(secret, body, t);
    expect(h).toMatch(/^t=1790000000,v1=[0-9a-f]{64}$/);
    expect(verifyBody(h, body, secret, { now: t + 10 })).toEqual({ ok: true, t });
  });

  it("rejects a bad signature, other secret or changed body", () => {
    const h = signBody(secret, body, t);
    expect(verifyBody(h, `${body} `, secret, { now: t })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyBody(h, body, `${secret}x`, { now: t })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const flipped = h.replace(/v1=(.)/, (_m, c) => `v1=${c === "0" ? "1" : "0"}`);
    expect(verifyBody(flipped, body, secret, { now: t })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects stale or future timestamps beyond ±300 s", () => {
    const h = signBody(secret, body, t);
    expect(verifyBody(h, body, secret, { now: t + 300 }).ok).toBe(true);
    expect(verifyBody(h, body, secret, { now: t - 300 }).ok).toBe(true);
    expect(verifyBody(h, body, secret, { now: t + 301 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyBody(h, body, secret, { now: t - 301 })).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects missing or malformed headers", () => {
    expect(verifyBody(null, body, secret, { now: t })).toEqual({ ok: false, reason: "missing" });
    for (const h of ["", "t=abc,v1=00", "v1=00", "t=1790000000", "t=1790000000,v1=zz"]) {
      expect(verifyBody(h, body, secret, { now: t }), h).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("accepts any matching v1 (secret rotation)", () => {
    const good = signBody(secret, body, t).split(",")[1];
    const h = `t=${t},v1=${"0".repeat(64)},${good}`;
    expect(verifyBody(h, body, secret, { now: t }).ok).toBe(true);
  });
});

describe("replay guard", () => {
  it("accepts a delivery id once within the window", () => {
    let now = 0;
    const g = createReplayGuard({ ttlMs: 600_000, now: () => now });
    expect(g.check("d1")).toBe(true);
    expect(g.check("d1")).toBe(false);
    now += 599_999;
    expect(g.check("d1")).toBe(false);
    now += 600_001;
    expect(g.check("d1")).toBe(true);
  });

  it("rejects empty ids and stays bounded", () => {
    const g = createReplayGuard({ max: 100 });
    expect(g.check("")).toBe(false);
    for (let i = 0; i < 1000; i++) g.check(`id-${i}`);
    expect(g.size()).toBeLessThanOrEqual(100);
  });
});
