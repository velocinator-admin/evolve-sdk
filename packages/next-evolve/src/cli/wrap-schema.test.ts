// T22.3: props → Zod on the wrap corpus (one snapshot per component) and the max-length heuristic.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTypescript } from "./pages";
import { type Detection, detectCandidates } from "./wrap-detect";
import { fixedComment, schemaSource, stringMax, stringMaxFor } from "./wrap-schema";

const CORPUS = resolve(__dirname, "../../test/wrap-corpus");

function corpus(): Detection {
  const d = detectCandidates(loadTypescript(CORPUS)!, CORPUS, "app");
  if ("error" in d) throw new Error(d.error);
  return d;
}

describe("schema per corpus component", () => {
  const d = corpus();
  const bySource = [...d.candidates].sort((a, b) => a.source.file.localeCompare(b.source.file));
  for (const c of bySource) {
    it(`${c.source.file} (${c.name})`, () => {
      const out = [schemaSource(c.props, c.longest), fixedComment(c.props) ?? "(all editable)"];
      expect(out.join("\n")).toMatchSnapshot();
    });
  }

  it("covers the spec's types: string, enum, number, number literals, boolean, optional, arrays", () => {
    const all = d.candidates.map((c) => schemaSource(c.props, c.longest)).join("\n");
    for (const s of [
      "z.string().max(",
      "z.enum([",
      "z.number()",
      "z.literal([2, 3, 4])",
      "z.boolean()",
      ".optional()",
      "z.array(z.string()",
    ])
      expect(all).toContain(s);
  });

  it("keeps objects, nodes, null, enums, URLs, styling and spread-in DOM props out", () => {
    const byName = new Map(d.candidates.map((c) => [c.name, c]));
    const fixed = (name: string) =>
      byName
        .get(name)!
        .props.filter((p) => !p.shape)
        .map((p) => p.name);
    expect(fixed("PricingTable")).toEqual(["plans"]);
    expect(fixed("Hero")).toEqual(["ctaHref", "className"]);
    expect(fixed("AnnouncementBar")).toEqual(["children", "theme"]);
    expect(fixed("StatsStrip")).toEqual(["title", "stats"]);
    expect(fixed("Countdown")).toEqual(["endsAt"]);
    // ComponentProps<"section"> contributes hundreds of DOM props: none show up.
    expect(byName.get("PricingCard")!.props.map((p) => p.name)).toEqual([
      "plan",
      "price",
      "currency",
      "features",
      "popular",
    ]);
  });
});

describe("string max length", () => {
  it("comes from the prop name", () => {
    expect(stringMaxFor("ctaLabel")).toBe(40);
    expect(stringMaxFor("buttonText")).toBe(40);
    expect(stringMaxFor("subtitle")).toBe(160);
    expect(stringMaxFor("tagline")).toBe(160);
    expect(stringMaxFor("title")).toBe(80);
    expect(stringMaxFor("headline")).toBe(80);
    expect(stringMaxFor("quote")).toBe(400);
    expect(stringMaxFor("description")).toBe(400);
    expect(stringMaxFor("whatever")).toBe(120);
  });

  it("grows so the value the page passes fits, with room", () => {
    expect(stringMax("ctaLabel", 10)).toBe(40);
    expect(stringMax("ctaLabel", 48)).toBe(80);
    expect(stringMax("title", 81)).toBe(130);
  });
});
