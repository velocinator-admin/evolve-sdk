// T22.2: candidate detection on the wrap corpus: expected candidates, ranked; skips explained.
import { resolve } from "node:path";
import { REGION_ID_RE } from "@next-evolve/protocol";
import { describe, expect, it } from "vitest";
import { project } from "../../test/project";
import { loadTypescript } from "./pages";
import { type Detection, detectCandidates, findPages, regionId, routeOf } from "./wrap-detect";

const CORPUS = resolve(__dirname, "../../test/wrap-corpus");
const ts = loadTypescript(CORPUS)!;

function detect(route?: string): Detection {
  const d = detectCandidates(ts, CORPUS, "app", route);
  if ("error" in d) throw new Error(d.error);
  return d;
}

describe("pages and routes", () => {
  it("maps page files to routes (groups and [evolve] dropped)", () => {
    expect(routeOf("app", "app/page.tsx")).toBe("/");
    expect(routeOf("app", "app/(marketing)/story/page.tsx")).toBe("/story");
    expect(routeOf("src/app", "src/app/[evolve]/pricing/page.tsx")).toBe("/pricing");
    expect(routeOf("app", "app/lp/[slug]/page.tsx")).toBe("/lp/[slug]");
    expect(findPages(CORPUS, "app").map((p) => p.route)).toEqual([
      "/story",
      "/extras",
      "/features",
      "/launch",
      "/newsletter",
      "/",
      "/pricing",
    ]);
  });

  it("an unknown route is an error that lists the pages", () => {
    const d = detectCandidates(ts, CORPUS, "app", "/nope");
    expect("error" in d && d.error).toMatch(/no page for \/nope.*\/pricing/);
  });
});

describe("candidates", () => {
  it("ranks a page's components: hero and CTA-like first, plain ones last", () => {
    expect(detect("/").candidates.map((c) => c.name)).toEqual(["Hero", "Testimonial", "LogoCloud"]);
    expect(detect("/features").candidates.map((c) => c.name)).toEqual([
      "ProductHighlight",
      "FeatureGrid",
      "SignupCta",
    ]);
    expect(detect("/pricing").candidates.map((c) => c.name)).toEqual([
      "PricingTable",
      "Faq",
      "PricingCard",
    ]);
    expect(detect("/launch").candidates.map((c) => c.name)).toEqual([
      "CtaBanner",
      "Countdown",
      "AnnouncementBar",
    ]);
    expect(detect("/newsletter").candidates.map((c) => c.name)).toEqual([
      "NewsletterSignup",
      "StatsStrip",
    ]);
    expect(detect("/story").candidates.map((c) => c.name)).toEqual(["HeroSplit", "StoryIntro"]);
    // forwardRef client component, anonymous default-exported arrow; generics are skipped.
    const extras = detect("/extras");
    expect(extras.candidates.map((c) => c.name)).toEqual(["PromoButton", "QuoteCard"]);
    expect(extras.skipped).toEqual([
      { page: "app/extras/page.tsx", tag: "OptionList", why: "a generic component" },
    ]);
  });

  it("recommends all but the weakest (StatsStrip: one optional caption)", () => {
    const d = detect();
    expect(d.candidates).toHaveLength(18);
    expect(d.candidates.filter((c) => !c.recommended).map((c) => c.name)).toEqual(["StatsStrip"]);
  });

  it("resolves sources: named, default, barrel re-exports, local components", () => {
    const by = new Map(detect().candidates.map((c) => [c.name, c.source]));
    expect(by.get("Hero")).toEqual({ file: "components/hero.tsx", exportName: "Hero" });
    expect(by.get("PricingTable")).toEqual({
      file: "components/pricing-table.tsx",
      exportName: "default",
    });
    expect(by.get("ProductHighlight")).toEqual({
      file: "components/marketing/product-highlight.tsx",
      exportName: "ProductHighlight",
    });
    expect(by.get("StoryIntro")).toEqual({
      file: "app/(marketing)/story/page.tsx",
      exportName: null,
    });
  });

  it("skips loops and prop-less components, and says why", () => {
    expect(detect("/").skipped).toEqual([
      {
        page: "app/page.tsx",
        tag: "Testimonial",
        why: "rendered inside a callback (e.g. .map()), so it isn't one region",
      },
      { page: "app/page.tsx", tag: "SiteFooter", why: "takes no props" },
    ]);
  });

  it("region ids are valid, unique and route-prefixed", () => {
    const ids = detect().candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(REGION_ID_RE);
    expect(ids).toContain("home-hero");
    expect(ids).toContain("pricing-table");
    expect(ids).toContain("launch-cta-banner");
  });

  it("skips ids already used by <Optimizable> in the app, and client pages", () => {
    const root = project({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          strict: true,
          moduleResolution: "bundler",
          module: "esnext",
        },
      }),
      "components/hero.tsx":
        "export function Hero(p: { title: string }) {\n  return <h1>{p.title}</h1>;\n}\n",
      "app/page.tsx": `import { Hero } from "../components/hero";
declare const Optimizable: (p: { id: string }) => null;
export default function Home() {
  return (
    <>
      <Optimizable id="home-hero" />
      <Hero title="Hi" />
    </>
  );
}
`,
      "app/client/page.tsx": `"use client";
import { Hero } from "../../components/hero";
export default function C() {
  return <Hero title="Hi" />;
}
`,
    });
    const d = detectCandidates(ts, root, "app");
    if ("error" in d) throw new Error(d.error);
    expect(d.candidates.map((c) => c.id)).toEqual(["home-hero-2"]);
    expect(d.skipped).toEqual([
      { page: "app/client/page.tsx", tag: "(page)", why: 'the page is "use client"' },
    ]);
  });
});

describe("regionId", () => {
  it("fits REGION_ID_RE even for long or odd names", () => {
    const taken = new Set<string>();
    const long = regionId(
      "/a-very-long-route-name/with/segments",
      "SuperLongComponentNameHere",
      taken,
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toMatch(REGION_ID_RE);
    expect(regionId("/", "Hero", taken)).toBe("home-hero");
    expect(regionId("/", "Hero", taken)).toBe("home-hero-2");
    expect(regionId("/lp/[slug]", "CTA", taken)).toBe("lp-slug-cta");
  });
});
