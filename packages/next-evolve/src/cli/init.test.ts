import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
  TEST_WEBHOOK_SECRET,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshApp, LAYOUT } from "../../test/apps";
import { project } from "../../test/project";
import { evolveMatcher } from "../config/cdn";
import { defineConfig } from "../config/config";
import { cacheComponentsPage } from "./doctor";
import { type InitDeps, initCommand } from "./init";
import { evalMatcher, matcherSource } from "./matcher";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(() => cloud.close());

function run(cwd: string, args: string[], over: Partial<InitDeps> = {}) {
  const lines: string[] = [];
  const setupDb = vi.fn(async () => ({ ok: true as const, applied: ["0001_init"] }));
  const push = vi.fn(async () => 0);
  const runCmd = vi.fn(async () => 0);
  const deps: InitDeps = {
    env: { EVOLVE_CLOUD_URL: cloud.url, EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV },
    cwd,
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    ask: null,
    setupDb,
    push,
    run: runCmd,
    ...over,
  };
  return initCommand(args, deps).then((code) => ({
    code,
    text: lines.join("\n"),
    setupDb,
    push,
    runCmd,
  }));
}
const keys = ["--key", TEST_SECRET_KEY, "--webhook-secret", TEST_WEBHOOK_SECRET];
const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");

describe("next-evolve init (spec §16.1)", () => {
  it("sets up a fresh app: files, proxy, layout, instrumentation, prebuild, env (never overwriting)", async () => {
    cloud.publish({
      site: TEST_SITE,
      routing: { routes: {}, experiments: {} },
      variants: {},
    });
    const dir = freshApp();
    const r = await run(dir, [...keys, "--yes", "--mode", "dynamic", "--routes", "/ /pricing"]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('Connected to "Fake site"');

    expect(read(dir, "evolve.config.ts")).toContain('"/pricing": { mode: "dynamic" }');
    expect(read(dir, "evolve.goals.ts")).toContain("defineGoals");
    const route = read(dir, "app/api/evolve/[...evolve]/route.ts");
    expect(route).toContain('from "../../../../evolve.config"');
    expect(route).toContain("maxDuration = 60");
    const proxy = read(dir, "proxy.ts");
    expect(proxy).toContain('import buildBundle from "./.evolve/bundle.generated"');
    expect(proxy).toContain('matcher: ["/", "/pricing", "/(ev_.*)"]');
    const layout = read(dir, "app/layout.tsx");
    expect(layout).toContain('import { EvolveScript } from "next-evolve/client";');
    expect(layout).toMatch(/ {8}<EvolveScript \/>\n {6}<\/body>/);
    expect(read(dir, "instrumentation.ts")).toContain("registerEvolve({ config, goals })");
    expect(JSON.parse(read(dir, "package.json")).scripts.prebuild).toBe("next-evolve pull");
    expect(read(dir, ".gitignore")).toContain(".evolve/");
    expect(existsSync(join(dir, ".evolve/bundle.generated.ts"))).toBe(true);

    const env = read(dir, ".env.local");
    expect(env.startsWith("DATABASE_URL=postgres://mine\nEVOLVE_TRACK_SECRET=keep-me\n")).toBe(
      true,
    );
    expect(env).toContain(`EVOLVE_SECRET_KEY=${TEST_SECRET_KEY}`);
    expect(env).toContain(`EVOLVE_WEBHOOK_SECRET=${TEST_WEBHOOK_SECRET}`);
    // --yes reuses DATABASE_URL; the track secret already there is kept.
    expect(env).toContain("EVOLVE_DATABASE_URL=postgres://mine");
    expect(env.match(/EVOLVE_TRACK_SECRET/g)).toHaveLength(1);
    expect(r.setupDb).toHaveBeenCalledWith("postgres://mine");
    expect(r.push).toHaveBeenCalled();
    expect(r.runCmd).not.toHaveBeenCalled(); // already installed
  });

  it("a create-next-app 16.4 project (cacheComponents, one-line <body>): dynamic mode on request, script added, <Suspense> hint", async () => {
    const dir = freshApp({
      "next.config.ts":
        "const nextConfig = { cacheComponents: true };\nexport default nextConfig;\n",
      "app/layout.tsx": `import "./globals.css";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
`,
    });
    const r = await run(dir, [...keys, "--yes", "--mode", "dynamic"]);
    expect(r.code, r.text).toBe(0);
    expect(read(dir, "evolve.config.ts")).toContain('"/": { mode: "dynamic" }');
    expect(existsSync(join(dir, "app/page.tsx"))).toBe(true); // not moved under [evolve]
    expect(existsSync(join(dir, "app/[evolve]"))).toBe(false);
    const layout = read(dir, "app/layout.tsx");
    expect(layout).toContain('import { EvolveScript } from "next-evolve/client";');
    expect(layout).toContain(
      '<body className="min-h-full flex flex-col">{children}<EvolveScript /></body>',
    );
    expect(r.text).not.toContain("Add <EvolveScript />");
    expect(r.text).toContain("<Suspense><Optimizable");
  });

  // T31.2: static mode with cacheComponents, the apps/fixture-cc way.
  it('cacheComponents: static mode by default, the page cached with "use cache" + cacheLife', async () => {
    const dir = freshApp({
      "next.config.ts": "export default { cacheComponents: true };\n",
      "app/pricing/page.tsx": `import type { Metadata } from "next";
import { Optimizable } from "next-evolve";
import Cta from "./cta";

export const metadata: Metadata = { title: "Pricing" };

export default function Pricing() {
  return <Optimizable id="cta" component={Cta} props={{ label: "Go" }} />;
}
`,
      "app/pricing/cta.tsx":
        "export default function Cta(p: { label: string }) {\n  return <a>{p.label}</a>;\n}\n",
      "app/about/page.tsx": `import { cookies } from "next/headers";

export default async function About() {
  return <p>{(await cookies()).get("x")?.value}</p>;
}
`,
    });
    const r = await run(dir, [...keys, "--yes", "--routes", "/ /pricing /about"]);
    expect(r.code, r.text).toBe(0);
    const config = read(dir, "evolve.config.ts");
    expect(config).toContain('"/": { mode: "static" }');
    expect(config).toContain('"/pricing": { mode: "static" }');
    // Reads request data: a cached page can't, so it stays dynamic and init says why.
    expect(config).toContain('"/about": { mode: "dynamic" }');
    expect(r.text).toContain(
      '/about: kept dynamic, the page reads cookies(), which a "use cache" page can\'t',
    );

    expect(existsSync(join(dir, "app/page.tsx"))).toBe(false);
    expect(read(dir, "app/[evolve]/page.tsx")).toBe(`import { cacheLife } from "next/cache";
import { type EvolvePageProps, evolveMetadata, evolveStaticParams, withEvolve } from "next-evolve";

function Home() {
  return <h1>Home</h1>;
}

// Static mode (next-evolve) with cacheComponents: one cached render per variant
// under [evolve], cached by "use cache" (Next rejects revalidate/dynamicParams here).
export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("/");
const EvolveHome = withEvolve(Home, { path: "/" });

export default async function CachedPage({ params }: EvolvePageProps) {
  "use cache";
  cacheLife("hours");
  return <EvolveHome params={params} />;
}
`);
    const pricing = read(dir, "app/[evolve]/pricing/page.tsx");
    // Merged into the page's own next-evolve import; metadata kept as the base.
    expect(pricing).toContain(
      'import { Optimizable, type EvolvePageProps, evolveMetadata, evolveStaticParams, withEvolve } from "next-evolve";',
    );
    expect(pricing).toContain('evolveMetadata("/pricing", metadata)');
    expect(pricing).toContain('const EvolvePricing = withEvolve(Pricing, { path: "/pricing" });');
    expect(existsSync(join(dir, "app/[evolve]/pricing/cta.tsx"))).toBe(true);
    // doctor's cacheComponents page check passes on both.
    for (const f of ["app/[evolve]/page.tsx", "app/[evolve]/pricing/page.tsx"])
      expect(cacheComponentsPage("/", f, read(dir, f))).toEqual([]);
    // Static pages under "use cache" don't need the <Suspense> hint (/about is dynamic, so it's there).
    expect(r.text).toContain("<Suspense><Optimizable");

    const allStatic = freshApp({ "next.config.ts": "export default { cacheComponents: true };\n" });
    const s = await run(allStatic, [...keys, "--yes"]);
    expect(s.code, s.text).toBe(0);
    expect(s.text).not.toContain("<Suspense>");
    expect(s.text).toContain('Wrap a component: <Optimizable id="hero"');

    // A re-run plans nothing.
    const again = await run(allStatic, [...keys, "--yes"]);
    expect(again.code, again.text).toBe(0);
    expect(again.text).toContain("files already set up");

    const cdn = await run(
      freshApp({ "next.config.ts": "export default { cacheComponents: true };\n" }),
      [...keys, "--yes", "--cdn-routing"],
    );
    expect(cdn.code).toBe(1);
    expect(cdn.text).toMatch(/--cdn-routing isn't supported with cacheComponents yet/);
  });

  it("installs next-evolve and zod with the app's package manager when missing", async () => {
    const dir = freshApp();
    const pkg = JSON.parse(read(dir, "package.json"));
    delete pkg.dependencies["next-evolve"];
    delete pkg.dependencies.zod;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const r = await run(dir, [...keys, "--yes", "--mode", "dynamic"]);
    expect(r.runCmd).toHaveBeenCalledWith("pnpm", ["add", "next-evolve", "zod@^4"], dir);
  });

  it("refuses without a key or with a key the cloud rejects", async () => {
    const dir = freshApp();
    const none = await run(dir, ["--yes"]);
    expect(none.code).toBe(1);
    expect(none.text).toMatch(/secret key is needed/);
    const bad = await run(
      dir,
      [
        "--yes",
        "--key",
        `evk_live_${TEST_SITE}_${"x".repeat(32)}`,
        "--webhook-secret",
        TEST_WEBHOOK_SECRET,
      ],
      {
        fetch: (async () =>
          new Response('{"error":"invalid_key"}', { status: 401 })) as typeof fetch,
      },
    );
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(/secret key was rejected/);
  });

  it("an existing middleware gets instructions instead of a new proxy; an existing register() gets the block", async () => {
    const dir = freshApp({
      "middleware.ts":
        'export function middleware() {}\nexport const config = { matcher: ["/app"] };\n',
      "instrumentation.ts": 'export function register() {\n  console.log("hi");\n}\n',
    });
    const r = await run(dir, [...keys, "--yes", "--mode", "dynamic"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "proxy.ts"))).toBe(false);
    expect(read(dir, "middleware.ts")).not.toContain("evolve");
    expect(r.text).toMatch(/Your middleware\.ts exists, so add Evolve to it/);
    const inst = read(dir, "instrumentation.ts");
    expect(inst).toContain("export async function register() {\n  if (process.env.NEXT_RUNTIME");
    expect(inst).toContain('console.log("hi");');
  });

  it("src/ layout on Next 15.5: middleware.ts with runtime nodejs under src/", async () => {
    const dir = project({
      "package.json": JSON.stringify({
        dependencies: { next: "15.5.2", "next-evolve": "*", zod: "*" },
      }),
      "package-lock.json": "",
      "tsconfig.json": "{}",
      "src/app/layout.tsx": LAYOUT,
    });
    const r = await run(dir, [...keys, "--yes", "--mode", "dynamic"]);
    expect(r.code, r.text).toBe(0);
    const mw = read(dir, "src/middleware.ts");
    expect(mw).toContain('import buildBundle from "../.evolve/bundle.generated"');
    expect(mw).toContain('import evolveConfig from "../evolve.config"');
    expect(mw).toContain('runtime: "nodejs"');
    expect(read(dir, "src/instrumentation.ts")).toContain('import("../evolve.config")');
    expect(existsSync(join(dir, "src/app/api/evolve/[...evolve]/route.ts"))).toBe(true);
  });

  it("aborts on an unsupported app before touching anything", async () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { next: "14.2.0" } }),
      "app/page.js": "",
    });
    const r = await run(dir, [...keys, "--yes"]);
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "evolve.config.js"))).toBe(false);
  });
});

/** Every file under dir (but node_modules) → content. */
function tree(dir: string, sub = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const p = sub ? `${sub}/${e.name}` : e.name;
    if (e.name === "node_modules") continue;
    if (e.isDirectory()) Object.assign(out, tree(dir, p));
    else out[p] = readFileSync(join(dir, p), "utf8");
  }
  return out;
}
const mtimes = (dir: string) =>
  Object.fromEntries(Object.keys(tree(dir)).map((p) => [p, statSync(join(dir, p)).mtimeMs]));

describe("init: idempotent, --dry-run, --yes (T11.5)", () => {
  const args = [...keys, "--yes", "--routes", "/ /pricing"];
  const app = () =>
    freshApp({
      "app/pricing/page.tsx":
        'import type { Metadata } from "next";\n\nexport const metadata: Metadata = { title: "Pricing" };\n\nexport default function Pricing() {\n  return <h1>Pricing</h1>;\n}\n',
    });

  it("writes the expected files (snapshot), and a re-run writes nothing", async () => {
    cloud.publish({ site: TEST_SITE, routing: { routes: {}, experiments: {} }, variants: {} });
    const dir = app();
    const first = await run(dir, args);
    expect(first.code, first.text).toBe(0);
    const files = tree(dir);
    delete files[".evolve/bundle.generated.ts"]; // a signed token, different every publish
    expect(files).toMatchSnapshot();

    const before = mtimes(dir);
    const again = await run(dir, args);
    expect(again.code, again.text).toBe(0);
    expect(again.text).toContain("files already set up");
    expect(again.text).not.toMatch(/^\s+(created|updated|removed) /m);
    expect(mtimes(dir)).toEqual(before);
  });

  it("--dry-run prints the diff and changes nothing: no files, install, migration or cloud writes", async () => {
    const dir = app();
    const pkg = JSON.parse(read(dir, "package.json"));
    delete pkg.dependencies.zod;
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const before = tree(dir);
    const putsBefore = cloud.calls.filter((c) => c.method === "PUT").length;

    const r = await run(dir, [...args, "--dry-run", "--app-url", "https://app.example.com"]);
    expect(r.code, r.text).toBe(0);
    expect(tree(dir)).toEqual(before);
    expect(r.runCmd).not.toHaveBeenCalled();
    expect(r.setupDb).not.toHaveBeenCalled();
    expect(r.push).not.toHaveBeenCalled();
    expect(cloud.calls.filter((c) => c.method === "PUT").length).toBe(putsBefore);
    expect(r.text).toContain("would install zod@^4");
    expect(r.text).toContain("would register the app URL https://app.example.com");
    expect(r.text).toContain("+++ app/[evolve]/pricing/page.tsx (new)");
    expect(r.text).toContain("--- app/pricing/page.tsx (removed)");
    // Secrets never printed.
    expect(r.text).not.toContain(TEST_SECRET_KEY);
    expect(r.text).toContain("EVOLVE_SECRET_KEY=…");
    expect(r.text.slice(r.text.indexOf("Would change:"))).toMatchSnapshot();
  });

  it("--yes never prompts; without it the DB reuse question is asked", async () => {
    const ask = vi.fn(async () => "y");
    await run(app(), args, { ask });
    expect(ask).not.toHaveBeenCalled();
    const asked = await run(app(), [...keys, "--routes", "/"], { ask });
    expect(asked.code, asked.text).toBe(0);
    expect(ask).toHaveBeenCalledWith(expect.stringMatching(/Use DATABASE_URL/));
  });
});

describe("init --cdn-routing (T19.5a)", () => {
  const args = [...keys, "--yes", "--routes", "/ /pricing", "--cdn-routing"];
  const CNA_NEXT_CONFIG = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
`;
  const app = (extra: Record<string, string> = {}) =>
    freshApp({
      "app/pricing/page.tsx": "export default function Pricing() {\n  return null;\n}\n",
      ...extra,
    });
  const expected = evolveMatcher(
    defineConfig({
      routes: { "/": { mode: "static" }, "/pricing": { mode: "static" } },
      cdnRouting: true,
    }),
  );

  it("turns cdnRouting on, writes the evolveMatcher() literal and the next.config rewrites; a re-run writes nothing", async () => {
    cloud.publish({ site: TEST_SITE, routing: { routes: {}, experiments: {} }, variants: {} });
    const dir = app({ "next.config.ts": CNA_NEXT_CONFIG });
    const r = await run(dir, args);
    expect(r.code, r.text).toBe(0);
    expect(read(dir, "evolve.config.ts")).toMatch(/\n {2}cdnRouting: true,\n/);
    const proxy = read(dir, "proxy.ts");
    expect(evalMatcher(matcherSource(proxy)!)).toEqual(expected);
    const next = read(dir, "next.config.ts");
    expect(next).toContain('import { evolveRewrites } from "next-evolve/config";');
    expect(next).toContain('import evolveConfig from "./evolve.config";');
    expect(next).toContain(
      "return { beforeFiles: evolveRewrites(evolveConfig), afterFiles: [], fallback: [] };",
    );
    expect(next).toContain("/* config options here */"); // the rest is kept
    expect({
      "evolve.config.ts": read(dir, "evolve.config.ts"),
      "proxy.ts": proxy,
      "next.config.ts": next,
    }).toMatchSnapshot();

    const before = mtimes(dir);
    const again = await run(dir, args);
    expect(again.code, again.text).toBe(0);
    expect(again.text).toContain("files already set up");
    expect(mtimes(dir)).toEqual(before);
  });

  it("creates next.config.ts when there is none", async () => {
    const dir = app();
    const r = await run(dir, args);
    expect(r.code, r.text).toBe(0);
    const next = read(dir, "next.config.ts");
    expect(next).toContain("evolveRewrites(evolveConfig)");
    expect(next).toContain("export default nextConfig;");
  });

  it("upgrades an app init set up earlier: config flag, matcher replaced, next.config edited", async () => {
    const dir = app({ "next.config.ts": CNA_NEXT_CONFIG });
    expect((await run(dir, [...keys, "--yes", "--routes", "/ /pricing"])).code).toBe(0);
    expect(read(dir, "proxy.ts")).toContain('matcher: ["/", "/pricing", "/(ev_.*)"]');
    const r = await run(dir, args);
    expect(r.code, r.text).toBe(0);
    expect(read(dir, "evolve.config.ts")).toContain("cdnRouting: true");
    expect(evalMatcher(matcherSource(read(dir, "proxy.ts"))!)).toEqual(expected);
    expect(read(dir, "next.config.ts")).toContain("evolveRewrites(evolveConfig)");
  });

  it("an existing rewrites() or an own proxy gets instructions instead of an edit", async () => {
    const own = `export default {\n  async rewrites() {\n    return [{ source: "/a", destination: "/b" }];\n  },\n};\n`;
    const dir = app({
      "next.config.ts": own,
      "proxy.ts":
        'import { NextResponse } from "next/server";\nexport function proxy() {\n  return NextResponse.next();\n}\nexport const config = { matcher: ["/app"] };\n',
    });
    const r = await run(dir, args);
    expect(r.code, r.text).toBe(0);
    expect(read(dir, "next.config.ts")).toBe(own);
    expect(r.text).toMatch(/next\.config\.ts already has rewrites/);
    expect(r.text).toContain("beforeFiles: evolveRewrites(evolveConfig)");
    expect(r.text).toMatch(/Your proxy\.ts exists/);
    expect(r.text).toContain('{ source: "/", missing: [{ type: "cookie", key: "evolve_r_');
  });

  it("needs static routes", async () => {
    const r = await run(app(), [...args, "--mode", "dynamic"]);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/--cdn-routing needs static routes/);
  });
});
