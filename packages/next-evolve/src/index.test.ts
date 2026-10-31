import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("next-evolve", () => {
  it("exports its name", async () => {
    const mod = await import("./index");
    expect(mod.SDK_NAME).toBe("next-evolve");
  });
});
