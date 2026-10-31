import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical";

describe("canonicalJson", () => {
  it("sorts keys recursively and drops whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
  it("is independent of insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  it("omits undefined object values", () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
  it("hashes to hex sha256", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
