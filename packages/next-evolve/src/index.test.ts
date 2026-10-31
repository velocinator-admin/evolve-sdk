import { describe, expect, it } from "vitest";

describe("next-evolve", () => {
  it("exports the server API", async () => {
    const mod = await import("./index");
    expect(Object.keys(mod).sort()).toEqual(
      [
        "Optimizable",
        "evolveMetadata",
        "evolveStaticParams",
        "getOptimizableMeta",
        "optimizable",
        "withEvolve",
      ].sort(),
    );
  });
});
