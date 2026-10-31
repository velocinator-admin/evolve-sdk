import { describe, expect, it } from "vitest";
import { MAX_ASSIGNMENTS, parseAssignments, serializeAssignments } from "./cookies";

describe("evolve_a cookie", () => {
  it("parses exp:var pairs and x exclusions", () => {
    expect(parseAssignments("k3j9x2:c1d2e3.p7q8r9:x")).toEqual(
      new Map([
        ["k3j9x2", "c1d2e3"],
        ["p7q8r9", "x"],
      ]),
    );
  });

  it("ignores malformed entries and handles empty input", () => {
    expect(parseAssignments(undefined).size).toBe(0);
    expect(parseAssignments("").size).toBe(0);
    expect(parseAssignments("bad.k3j9x2:c1d2e3.K3J9X2:c1d2e3.aaaaaa:bbbbbbb.aaaaaa:")).toEqual(
      new Map([["k3j9x2", "c1d2e3"]]),
    );
  });

  it("keeps the first value for a repeated experiment", () => {
    expect(parseAssignments("k3j9x2:c1d2e3.k3j9x2:a8f2l1").get("k3j9x2")).toBe("c1d2e3");
  });

  it("serializes in a stable order, capped at 20 entries", () => {
    expect(
      serializeAssignments(
        new Map([
          ["k3j9x2", "c1d2e3"],
          ["a00000", "x"],
        ]),
      ),
    ).toBe("a00000:x.k3j9x2:c1d2e3");
    const many = new Map(
      Array.from({ length: 30 }, (_, i) => [`e${String(i).padStart(5, "0")}`, "x"]),
    );
    expect(serializeAssignments(many).split(".")).toHaveLength(MAX_ASSIGNMENTS);
  });

  it("round-trips", () => {
    const m = new Map([
      ["k3j9x2", "c1d2e3"],
      ["p7q8r9", "x"],
    ]);
    expect(parseAssignments(serializeAssignments(m))).toEqual(m);
  });
});
