import { decodeCode, encodeCode } from "@next-evolve/protocol";
import { describe, expect, it } from "vitest";
import { sampleBundle } from "../../test/samples";
import { assign, weightedPick } from "./assign";

const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length]!;
};

describe("assign", () => {
  it("new visitor: draws traffic then a weighted variant", () => {
    const r = assign(sampleBundle(), "/", new Map(), seq(0.1, 0.75));
    expect(r.pairs).toEqual([{ exp: "k3j9x2", var: "c1d2e3", counted: true }]);
    expect(r.assigned.get("k3j9x2")).toBe("c1d2e3");
    expect(r.changed).toBe(true);
  });

  it("returning visitor keeps an active assignment, no cookie change", () => {
    const r = assign(sampleBundle(), "/", new Map([["k3j9x2", "a8f2l1"]]), () => {
      throw new Error("must not draw");
    });
    expect(r.pairs).toEqual([{ exp: "k3j9x2", var: "a8f2l1", counted: true }]);
    expect(r.changed).toBe(false);
  });

  it("excluded visitor renders control, not counted", () => {
    const r = assign(sampleBundle(), "/", new Map([["k3j9x2", "x"]]), seq(0));
    expect(r.pairs).toEqual([{ exp: "k3j9x2", var: "a8f2l1", counted: false }]);
    expect(r.changed).toBe(false);
  });

  it("outside traffic share → excluded and remembered", () => {
    const b = sampleBundle((b) => (b.routing.experiments.k3j9x2!.traffic = 0.3));
    const r = assign(b, "/", new Map(), seq(0.3));
    expect(r.pairs).toEqual([{ exp: "k3j9x2", var: "a8f2l1", counted: false }]);
    expect(r.assigned.get("k3j9x2")).toBe("x");
    expect(r.changed).toBe(true);
  });

  it("completed experiment renders the winner, not counted, without touching cookies", () => {
    const r = assign(sampleBundle(), "/pricing", new Map([["k3j9x2", "c1d2e3"]]), seq(0.5));
    expect(r.pairs).toEqual([
      { exp: "k3j9x2", var: "c1d2e3", counted: true },
      { exp: "p7q8r9", var: "s4t5u6", counted: false },
    ]);
    expect(r.changed).toBe(false);
    expect(decodeCode(encodeCode(r.pairs))).toEqual(r.pairs);
  });

  it("assignment to a removed or zero-weight variant is redrawn", () => {
    const b = sampleBundle((b) => (b.routing.experiments.k3j9x2!.variants[1]!.w = 0));
    const r = assign(b, "/", new Map([["k3j9x2", "c1d2e3"]]), seq(0.1, 0.99));
    expect(r.pairs).toEqual([{ exp: "k3j9x2", var: "a8f2l1", counted: true }]);
    expect(r.changed).toBe(true);
    const r2 = assign(sampleBundle(), "/", new Map([["k3j9x2", "zzzzzz"]]), seq(0.1, 0.1));
    expect(r2.assigned.get("k3j9x2")).toBe("a8f2l1");
  });

  it("route without experiments → no pairs", () => {
    const r = assign(sampleBundle(), "/features", new Map(), seq(0.1));
    expect(r.pairs).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it("prunes cookie entries for experiments not in the bundle", () => {
    const r = assign(
      sampleBundle(),
      "/",
      new Map([
        ["k3j9x2", "a8f2l1"],
        ["old000", "x"],
      ]),
      seq(0),
    );
    expect([...r.assigned.keys()]).toEqual(["k3j9x2"]);
    expect(r.changed).toBe(true);
  });

  it("keeps assignments for experiments on other routes", () => {
    const b = sampleBundle((b) => {
      b.routing.routes["/other"] = ["k3j9x2"];
      b.routing.routes["/"] = [];
    });
    const r = assign(b, "/", new Map([["k3j9x2", "a8f2l1"]]), seq(0));
    expect(r.assigned.get("k3j9x2")).toBe("a8f2l1");
    expect(r.changed).toBe(false);
  });

  it("100k draws land within ±1% of the weights", () => {
    const b = sampleBundle((b) => {
      b.routing.experiments.k3j9x2!.variants = [
        { id: "a8f2l1", w: 0.2 },
        { id: "c1d2e3", w: 0.8 },
      ];
    });
    const counts = new Map<string, number>();
    for (let i = 0; i < 100_000; i++) {
      const v = assign(b, "/", new Map(), Math.random).pairs[0]!.var;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(Math.abs(counts.get("a8f2l1")! / 100_000 - 0.2)).toBeLessThan(0.01);
    expect(Math.abs(counts.get("c1d2e3")! / 100_000 - 0.8)).toBeLessThan(0.01);
  });
});

describe("weightedPick", () => {
  const vs = [
    { id: "aaaaaa", w: 1 },
    { id: "bbbbbb", w: 0 },
    { id: "cccccc", w: 3 },
  ];
  it("maps r to cumulative weight, skipping zero weights", () => {
    expect(weightedPick(vs, 0)).toBe("aaaaaa");
    expect(weightedPick(vs, 0.249)).toBe("aaaaaa");
    expect(weightedPick(vs, 0.25)).toBe("cccccc");
    expect(weightedPick(vs, 0.999999)).toBe("cccccc");
  });
});
