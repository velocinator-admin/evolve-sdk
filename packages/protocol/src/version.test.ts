import { describe, expect, it } from "vitest";
import {
  cloudProtocolFor,
  isSupportedProtocol,
  negotiateProtocol,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOLS,
  UnsupportedProtocolError,
  unsupportedProtocolBody,
} from "./version";

describe("protocol versions", () => {
  it("phase 1 speaks pv 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(SUPPORTED_PROTOCOLS).toEqual([1]);
    expect(isSupportedProtocol(1)).toBe(true);
    expect(isSupportedProtocol(2)).toBe(false);
    expect(isSupportedProtocol("1")).toBe(false);
  });

  it("negotiates the highest common version", () => {
    expect(negotiateProtocol([1], [1])).toBe(1);
    expect(negotiateProtocol([1, 2], [1])).toBe(1);
    expect(negotiateProtocol([1, 2], [2, 1])).toBe(2);
    expect(negotiateProtocol([2], [1])).toBeNull();
    expect(negotiateProtocol([], [1])).toBeNull();
  });

  // Synthetic v2 world: the cloud is on N=2 and keeps N−1=1.
  const table: [number, number[], number | null][] = [
    [1, [1], 1],
    [2, [1], 1], // old SDK still served at N−1
    [2, [1, 2], 2], // new SDK gets N
    [2, [2], 2],
    [3, [1], null], // SDK older than N−1: upgrade required
    [3, [1, 2], 2],
    [1, [2], null], // SDK ahead of the cloud and without N
  ];
  for (const [cloud, site, want] of table) {
    it(`cloud N=${cloud}, site [${site}] → ${want}`, () => {
      expect(cloudProtocolFor(cloud, site)).toBe(want);
    });
  }

  it("builds the unsupported_protocol answer", () => {
    expect(unsupportedProtocolBody()).toEqual({ error: "unsupported_protocol", supported: [1] });
    const e = new UnsupportedProtocolError(2);
    expect(e.message).toContain("2");
  });
});
