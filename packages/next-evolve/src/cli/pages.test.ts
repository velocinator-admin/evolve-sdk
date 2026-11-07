import { describe, expect, it } from "vitest";
import { project } from "../../test/project";
import { detectProject } from "./detect";
import type { RouteMode } from "./files";
import { planPages } from "./pages";
import { Plan } from "./plan";

const PKG = JSON.stringify({ dependencies: { next: "16.4.3", "next-evolve": "*", zod: "*" } });
const LAYOUT =
  "export default function L({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n";

function setup(files: Record<string, string>, paths: string[]) {
  const root = project({ "package.json": PKG, "tsconfig.json": "{}", ...files });
  const plan = new Plan(root);
  const d = detectProject(root);
  const routes: RouteMode[] = paths.map((path) => ({ path, mode: "static" }));
  const out = planPages(plan, d, routes);
  return { root, plan, d, out, routes };
}
const modes = (rs: RouteMode[]) => Object.fromEntries(rs.map((r) => [r.path, r.mode]));

describe("static-mode page move (spec §16.1 step 7)", () => {
  it("pattern route: app/lp/[slug] moves to app/[evolve]/lp/[slug] (D77)", () => {
    const { plan, out } = setup(
      {
        "app/lp/[slug]/page.tsx": `export default async function Landing({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <p>{slug}</p>;
}
`,
        "app/docs/[[...path]]/page.tsx":
          "export default function Docs() {\n  return <p>docs</p>;\n}\n",
      },
      ["/lp/:slug", "/docs/:path*"],
    );
    expect(modes(out)).toEqual({ "/lp/:slug": "static", "/docs/:path*": "static" });
    expect(plan.read("app/lp/[slug]/page.tsx")).toBeNull();
    const page = plan.read("app/[evolve]/lp/[slug]/page.tsx")!;
    expect(page).toContain('export default withEvolve(Landing, { path: "/lp/:slug" });');
    expect(page).toContain('export const generateMetadata = evolveMetadata("/lp/:slug");');
    expect(plan.read("app/[evolve]/docs/[[...path]]/page.tsx")).toContain(
      'withEvolve(Docs, { path: "/docs/:path*" })',
    );
  });

  it("plain page: moved under [evolve], wrapped, params and metadata exported", () => {
    const { plan, out } = setup(
      {
        "app/layout.tsx": LAYOUT,
        "app/pricing/page.tsx": `import Cta from "../../components/cta";

export default function Pricing() {
  return <Cta />;
}
`,
      },
      ["/pricing"],
    );
    expect(modes(out)).toEqual({ "/pricing": "static" });
    expect(plan.read("app/pricing/page.tsx")).toBeNull();
    const page = plan.read("app/[evolve]/pricing/page.tsx")!;
    expect(page).toContain(
      'import { evolveMetadata, evolveStaticParams, withEvolve } from "next-evolve";',
    );
    expect(page).toContain('import Cta from "../../../components/cta";');
    expect(page).toContain("function Pricing() {");
    expect(page).not.toContain("export default function");
    expect(page).toContain("export const dynamicParams = true;");
    expect(page).toContain("export const generateStaticParams = evolveStaticParams;");
    expect(page).toContain("export const revalidate = 3600;");
    expect(page).toContain('export const generateMetadata = evolveMetadata("/pricing");');
    expect(page).toContain('export default withEvolve(Pricing, { path: "/pricing" });');
  });

  it("metadata object and generateMetadata are merged into evolveMetadata", () => {
    const { plan } = setup(
      {
        "app/a/page.tsx": `import type { Metadata } from "next";
export const metadata: Metadata = { title: "A" };
export default function A() {
  return <p>a</p>;
}
`,
        "app/b/page.tsx": `export async function generateMetadata() {
  return { title: "B" };
}
const B = () => <p>b</p>;
export default B;
`,
      },
      ["/a", "/b"],
    );
    const a = plan.read("app/[evolve]/a/page.tsx")!;
    expect(a).toContain('const metadata: Metadata = { title: "A" };');
    expect(a).not.toContain("export const metadata");
    expect(a).toContain('export const generateMetadata = evolveMetadata("/a", metadata);');
    const b = plan.read("app/[evolve]/b/page.tsx")!;
    expect(b).toContain("async function baseMetadata() {");
    expect(b).toContain('export const generateMetadata = evolveMetadata("/b", baseMetadata);');
    expect(b).not.toMatch(/^export default B;$/m);
    expect(b).toContain('export default withEvolve(B, { path: "/b" });');
  });

  it("anonymous and expression default exports get a name", () => {
    const { plan } = setup(
      {
        "app/a/page.tsx": "export default function () {\n  return <p>a</p>;\n}\n",
        "app/b/page.jsx": "export default () => <p>b</p>;\n",
      },
      ["/a", "/b"],
    );
    expect(plan.read("app/[evolve]/a/page.tsx")).toContain("function Page() {");
    const b = plan.read("app/[evolve]/b/page.jsx")!;
    expect(b).toContain("const Page = () => <p>b</p>;");
    expect(b).toContain('export default withEvolve(Page, { path: "/b" });');
  });

  it("co-located loading.tsx and helpers move along; imports between them still work", () => {
    const { plan } = setup(
      {
        "app/pricing/page.tsx": `import { plans } from "./plans";
import "./pricing.css";
export default function Pricing() {
  return <p>{plans.length}</p>;
}
`,
        "app/pricing/plans.ts":
          'import { money } from "../../lib/money";\nexport const plans = [money(1)];\n',
        "app/pricing/pricing.css": "p{}",
        "app/pricing/loading.tsx": "export default function L() {\n  return null;\n}\n",
      },
      ["/pricing"],
    );
    for (const f of ["page.tsx", "plans.ts", "pricing.css", "loading.tsx"]) {
      expect(plan.read(`app/pricing/${f}`), f).toBeNull();
      expect(plan.read(`app/[evolve]/pricing/${f}`), f).not.toBeNull();
    }
    const page = plan.read("app/[evolve]/pricing/page.tsx")!;
    expect(page).toContain('from "./plans"');
    expect(page).toContain('import "./pricing.css"');
    expect(plan.read("app/[evolve]/pricing/plans.ts")).toContain('from "../../../lib/money"');
    expect(plan.read("app/[evolve]/pricing/loading.tsx")).toBe(
      "export default function L() {\n  return null;\n}\n",
    );
  });

  it('"/": only page moves (root layout/loading wrap [evolve] too)', () => {
    const { plan, out } = setup(
      {
        "app/layout.tsx": LAYOUT,
        "app/loading.tsx": "export default function L() {\n  return null;\n}\n",
        "app/page.tsx":
          'import { Hero } from "./hero";\nexport default function Home() {\n  return <Hero />;\n}\n',
        "app/hero.tsx": "export const Hero = () => null;\n",
      },
      ["/"],
    );
    expect(modes(out)).toEqual({ "/": "static" });
    const page = plan.read("app/[evolve]/page.tsx")!;
    expect(page).toContain('from "../hero"');
    expect(page).toContain('withEvolve(Home, { path: "/" })');
    expect(plan.read("app/loading.tsx")).not.toBeNull();
    expect(plan.read("app/hero.tsx")).not.toBeNull();
    expect(plan.read("app/layout.tsx")).not.toBeNull();
  });

  it("src/app", () => {
    const { plan, out } = setup(
      {
        "src/app/layout.tsx": LAYOUT,
        "src/app/page.tsx": "export default function H() {\n  return null;\n}\n",
      },
      ["/"],
    );
    expect(modes(out)).toEqual({ "/": "static" });
    expect(plan.read("src/app/[evolve]/page.tsx")).toContain("withEvolve(H");
    expect(plan.read("src/app/page.tsx")).toBeNull();
  });

  it("a root [slug] conflicts with [evolve]: every route stays dynamic", () => {
    const { plan, out } = setup(
      {
        "app/page.tsx": "export default function H() {\n  return null;\n}\n",
        "app/[slug]/page.tsx": "export default function S() {\n  return null;\n}\n",
      },
      ["/"],
    );
    expect(modes(out)).toEqual({ "/": "dynamic" });
    expect(plan.changes()).toEqual([]);
    expect(plan.notes.join("\n")).toMatch(/app\/\[slug\].*conflicts.*dynamic/);
  });

  it("force-dynamic, own generateStaticParams, client pages, route groups, missing pages → dynamic with a note", () => {
    const { plan, out } = setup(
      {
        "app/a/page.tsx":
          'export const dynamic = "force-dynamic";\nexport default function A() {\n  return null;\n}\n',
        "app/b/page.tsx":
          "export function generateStaticParams() {\n  return [];\n}\nexport default function B() {\n  return null;\n}\n",
        "app/c/page.tsx": '"use client";\nexport default function C() {\n  return null;\n}\n',
        "app/(marketing)/d/page.tsx": "export default function D() {\n  return null;\n}\n",
      },
      ["/a", "/b", "/c", "/d", "/e"],
    );
    expect(modes(out)).toEqual({
      "/a": "dynamic",
      "/b": "dynamic",
      "/c": "dynamic",
      "/d": "dynamic",
      "/e": "dynamic",
    });
    expect(plan.changes()).toEqual([]);
    const notes = plan.notes.join("\n");
    expect(notes).toMatch(/\/a.*force-dynamic/);
    expect(notes).toMatch(/\/b.*generateStaticParams/);
    expect(notes).toMatch(/\/c.*"use client"/);
    expect(notes).toMatch(/\/d.*route group/);
    expect(notes).toMatch(/\/e.*no page/);
  });

  it("child routes: a folder with its own layout stays dynamic; without one only page.tsx moves", () => {
    const { plan, out } = setup(
      {
        "app/docs/page.tsx": "export default function D() {\n  return null;\n}\n",
        "app/docs/layout.tsx": LAYOUT,
        "app/docs/intro/page.tsx": "export default function I() {\n  return null;\n}\n",
        "app/blog/page.tsx": "export default function B() {\n  return null;\n}\n",
        "app/blog/util.ts": "export const x = 1;\n",
        "app/blog/first/page.tsx": "export default function F() {\n  return null;\n}\n",
      },
      ["/docs", "/blog"],
    );
    expect(modes(out)).toEqual({ "/docs": "dynamic", "/blog": "static" });
    expect(plan.notes.join("\n")).toMatch(/\/docs.*layout/);
    expect(plan.read("app/[evolve]/blog/page.tsx")).not.toBeNull();
    expect(plan.read("app/blog/util.ts")).not.toBeNull();
    expect(plan.read("app/blog/first/page.tsx")).not.toBeNull();
  });

  it("re-running after the move plans nothing and keeps the route static", () => {
    const { root, plan } = setup(
      { "app/pricing/page.tsx": "export default function P() {\n  return null;\n}\n" },
      ["/pricing"],
    );
    plan.apply();
    const again = new Plan(root);
    const out = planPages(again, detectProject(root), [{ path: "/pricing", mode: "static" }]);
    expect(modes(out)).toEqual({ "/pricing": "static" });
    expect(again.changes()).toEqual([]);
  });

  it("an existing next-evolve import only gains the missing names", () => {
    const { plan } = setup(
      {
        "app/page.tsx":
          'import { Optimizable } from "next-evolve";\nexport default function H() {\n  return <Optimizable id="x" component={() => null} props={{}} />;\n}\n',
      },
      ["/"],
    );
    const page = plan.read("app/[evolve]/page.tsx")!;
    expect(page).toContain(
      'import { Optimizable, evolveMetadata, evolveStaticParams, withEvolve } from "next-evolve";',
    );
    expect(page.match(/from "next-evolve"/g)).toHaveLength(1);
  });

  // T31.2: with cacheComponents the page caches itself ("use cache" + cacheLife).
  it("cacheComponents: anonymous/JS pages, names already taken, an own cacheLife import; .ts and segment config stay dynamic", () => {
    const cc = { "next.config.ts": "export default { cacheComponents: true };\n" };
    const { plan, out, d } = setup(
      {
        ...cc,
        "app/a/page.tsx": "export default function () {\n  return <p>a</p>;\n}\n",
        "app/b/page.jsx": "export default () => <p>b</p>;\n",
        "app/c/page.tsx":
          'import { cacheLife } from "next/cache";\nconst EvolveC = 1;\nfunction CachedPage() {\n  return <p>{EvolveC}</p>;\n}\nexport default function C() {\n  return <CachedPage />;\n}\n',
        "app/d/page.ts": 'export default function D() {\n  return "d";\n}\n',
        "app/e/page.tsx":
          "export const revalidate = 60;\nexport default function E() {\n  return <p>e</p>;\n}\n",
      },
      ["/a", "/b", "/c", "/d", "/e"],
    );
    expect(d.cacheComponents).toBe(true);
    expect(modes(out)).toEqual({
      "/a": "static",
      "/b": "static",
      "/c": "static",
      "/d": "dynamic",
      "/e": "dynamic",
    });
    const a = plan.read("app/[evolve]/a/page.tsx")!;
    expect(a).toContain("const EvolvePage = withEvolve(Page, {");
    expect(a).toContain("export default async function CachedPage({ params }: EvolvePageProps) {");
    expect(a).not.toMatch(/export const (revalidate|dynamicParams)/);
    const b = plan.read("app/[evolve]/b/page.jsx")!;
    expect(b).toContain(
      'import { evolveMetadata, evolveStaticParams, withEvolve } from "next-evolve";',
    );
    expect(b).toContain("export default async function CachedPage({ params }) {");
    const c = plan.read("app/[evolve]/c/page.tsx")!;
    expect(c.match(/from "next\/cache"/g)).toHaveLength(1);
    expect(c).toContain("const EvolveC2 = withEvolve(C, {");
    expect(c).toContain("export default async function CachedPage2({ params }: EvolvePageProps) {");
    expect(c).toContain("return <EvolveC2 params={params} />;");
    expect(plan.notes.join("\n")).toContain("page.ts can't hold the JSX");
    expect(plan.notes.join("\n")).toContain("exports revalidate, which cacheComponents rejects");
  });
});
