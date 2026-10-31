import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CODE_RE, CONTROL_CODE, type CodePair, decodeCode, encodeCode } from "./code";

const idArb = fc.stringMatching(/^[a-z0-9]{6}$/);
const pairsArb = fc
  .uniqueArray(fc.record({ exp: idArb, v: idArb, counted: fc.boolean() }), {
    selector: (p) => p.exp,
    maxLength: 3,
  })
  .map((ps) => ps.map(({ exp, v, counted }): CodePair => ({ exp, var: v, counted })));

describe("variant code", () => {
  it("no pairs encodes to ev_0", () => {
    expect(encodeCode([])).toBe(CONTROL_CODE);
    expect(decodeCode("ev_0")).toEqual([]);
  });

  it("sorts pairs by experiment id and uses - / ~", () => {
    const code = encodeCode([
      { exp: "zzzzz1", var: "bbbbbb", counted: false },
      { exp: "aaaaa1", var: "cccccc", counted: true },
    ]);
    expect(code).toBe("ev_aaaaa1-cccccc.zzzzz1~bbbbbb");
  });

  it("round-trips (property)", () => {
    fc.assert(
      fc.property(pairsArb, (pairs) => {
        const code = encodeCode(pairs);
        expect(code).toMatch(CODE_RE);
        expect(code.length).toBeLessThanOrEqual(44);
        const sorted = [...pairs].sort((a, b) => (a.exp < b.exp ? -1 : 1));
        expect(decodeCode(code)).toEqual(sorted);
      }),
    );
  });

  it("rejects malformed codes", () => {
    for (const bad of [
      "",
      "ev_",
      "ev_00",
      "EV_0",
      "ev_aaaaaa-bbbbbb.",
      "ev_aaaaaa_bbbbbb",
      "ev_aaaaa-bbbbbb",
      "ev_aaaaaa-bbbbbb.cccccc-dddddd.eeeeee-ffffff.gggggg-hhhhhh",
      "ev_bbbbbb-cccccc.aaaaaa-dddddd", // not sorted
      "ev_aaaaaa-cccccc.aaaaaa~dddddd", // duplicate experiment
      "ev_aaaaaa-bbbbbb/x",
    ]) {
      expect(decodeCode(bad), bad).toBeNull();
    }
  });

  it("encode refuses invalid input", () => {
    expect(() => encodeCode([{ exp: "BAD", var: "bbbbbb", counted: true }])).toThrow();
    const four = ["a", "b", "c", "d"].map((c) => ({
      exp: c.repeat(6),
      var: "vvvvvv",
      counted: true,
    }));
    expect(() => encodeCode(four)).toThrow();
  });
});
