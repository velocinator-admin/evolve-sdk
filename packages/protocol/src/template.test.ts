import { describe, expect, it } from "vitest";
import { fillPlaceholders, MAX_VAR_VALUE_LENGTH, placeholdersIn } from "./template";

describe("{var} placeholders (TPL-1.2)", () => {
  it("finds var names in nested string props", () => {
    expect(
      placeholdersIn({ title: "Hire {name} today", items: ["{city}", { x: "{name}" }], n: 3 }),
    ).toEqual(["city", "name"]);
    expect(placeholdersIn({ t: "no {vars here} {1x} {}" })).toEqual([]);
  });

  it("fills every placeholder", () => {
    expect(
      fillPlaceholders({ title: "Hire {name} today", n: 1 }, { name: "Christopher-G" }),
    ).toEqual({ ok: true, value: { title: "Hire Christopher-G today", n: 1 } });
  });

  it("a missing or oversized var fails the whole fill", () => {
    expect(fillPlaceholders({ a: "{name}", b: "{city}" }, { name: "x" })).toEqual({
      ok: false,
      missing: "city",
    });
    expect(
      fillPlaceholders({ a: "{name}" }, { name: "x".repeat(MAX_VAR_VALUE_LENGTH + 1) }).ok,
    ).toBe(false);
    // Inherited keys don't count as vars.
    expect(fillPlaceholders({ a: "{toString}" }, {}).ok).toBe(false);
  });

  it("values are inserted literally (no re-expansion)", () => {
    expect(fillPlaceholders("{a}", { a: "{b}", b: "x" })).toEqual({ ok: true, value: "{b}" });
  });
});
