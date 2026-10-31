import { describe, expect, it } from "vitest";

describe("next-evolve", () => {
  it("exports its name", async () => {
    const mod = await import("./index");
    expect(mod.SDK_NAME).toBe("next-evolve");
  });
});
