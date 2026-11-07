// T22.4: the wrap command: diff first, dry run, picking, the rewrite, and
// all-or-nothing writes (an injected check failure restores every byte).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { project } from "../../test/project";
import { parsePick, tscErrorFiles, type VerifyStep, type WrapDeps, wrapCommand } from "./wrap";
import type { Candidate } from "./wrap-detect";

// Each test builds a TypeScript program over the corpus: ~6 s on a CI runner.
vi.setConfig({ testTimeout: 30_000 });

const PKG = JSON.stringify({
  name: "app",
  dependencies: { next: "16.4.3", "next-evolve": "0.7.1", react: "19.3.1", zod: "4.6.7" },
});
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    jsx: "react-jsx",
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
  },
});
const HERO = `export function Hero({ title, cta, href }: { title: string; cta: string; href: string }) {
  return (
    <section>
      <h1>{title}</h1>
      <a href={href}>{cta}</a>
    </section>
  );
}

export function Banner(props: { children: string; tone?: "info" | "warn" }) {
  return <p data-tone={props.tone}>{props.children}</p>;
}
`;
const PAGE = `import type { Metadata } from "next";
import { Banner, Hero } from "../components/hero";

export const metadata: Metadata = { title: "Home" };

export default function Home() {
  return (
    <main>
      <Hero title="Ship faster" cta="Start free" href="/signup" />
      <Banner tone="info">
        Launch week
      </Banner>
    </main>
  );
}
`;

function app(extra: Record<string, string> = {}) {
  return project({
    "package.json": PKG,
    "tsconfig.json": TSCONFIG,
    "components/hero.tsx": HERO,
    "app/page.tsx": PAGE,
    ...extra,
  });
}

/** Every file under root → its bytes (base64), for byte-identical checks. */
function tree(root: string, dir = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(root, dir))) {
    const p = dir ? `${dir}/${e}` : e;
    if (statSync(join(root, p)).isDirectory()) Object.assign(out, tree(root, p));
    else out[p] = readFileSync(join(root, p)).toString("base64");
  }
  return out;
}

function deps(root: string, over: Partial<WrapDeps> = {}) {
  const log: string[] = [];
  const steps: VerifyStep[] = [];
  const d: WrapDeps = {
    cwd: root,
    out: (s) => log.push(s),
    err: (s) => log.push(s),
    ask: null,
    verify: async (step) => {
      steps.push(step);
      return { ok: true, output: "" };
    },
    ...over,
  };
  return { d, log, steps, text: () => log.join("\n") };
}

describe("wrap", () => {
  it("--dry-run prints the diff and writes nothing", async () => {
    const root = app();
    const before = tree(root);
    const t = deps(root);
    expect(await wrapCommand(["--dry-run"], t.d)).toBe(0);
    expect(tree(root)).toEqual(before);
    expect(t.text()).toContain("+++ components/hero.evolve.ts (new)");
    expect(t.text()).toContain("*** app/page.tsx");
    expect(t.text()).toContain("Dry run: 2 file(s) would change");
    expect(t.steps).toEqual([]);
  });

  it("--yes writes the sibling schema file and the <Optimizable> usage, then runs tsc", async () => {
    const root = app();
    const t = deps(root);
    expect(await wrapCommand(["/", "--yes"], t.d)).toBe(0);
    expect(t.steps).toEqual(["tsc"]);
    expect(readFileSync(join(root, "components/hero.tsx"), "utf8")).toBe(HERO);
    expect(readFileSync(join(root, "components/hero.evolve.ts"), "utf8")).toMatchSnapshot();
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).toMatchSnapshot();
    expect(t.text()).toContain("✓ Wrapped 2 region(s)");
    expect(t.text()).toContain("! Add / to routes in evolve.config");
  });

  it("an injected tsc failure restores every file byte-identical (new files removed)", async () => {
    // CRLF, a BOM and an existing sibling with other content: restored as bytes, not re-encoded.
    const sibling = "﻿// mine\r\nexport const other = 1;\r\n";
    const root = app({ "components/hero.evolve.ts": sibling });
    writeFileSync(join(root, "app/page.tsx"), PAGE.replace(/\n/g, "\r\n"));
    const before = tree(root);
    const t = deps(root, {
      verify: async () => ({ ok: false, output: "app/page.tsx(9,7): error TS2322: nope" }),
    });
    expect(await wrapCommand(["--yes"], t.d)).toBe(1);
    expect(tree(root)).toEqual(before);
    expect(t.text()).toContain("tsc failed after wrapping; every file is restored");
  });

  it("--build also runs next build; a build failure restores too", async () => {
    const root = app();
    const before = tree(root);
    const steps: VerifyStep[] = [];
    const t = deps(root, {
      verify: async (step) => {
        steps.push(step);
        return { ok: step === "tsc", output: "Build error occurred" };
      },
    });
    expect(await wrapCommand(["--yes", "--build"], t.d)).toBe(1);
    expect(steps).toEqual(["tsc", "next build"]);
    expect(tree(root)).toEqual(before);
    expect(existsSync(join(root, "components/hero.evolve.ts"))).toBe(false);
  });

  it("--component picks by name; an unknown name is an error", async () => {
    const root = app();
    const t = deps(root);
    expect(await wrapCommand(["--component", "Nope"], t.d)).toBe(1);
    expect(t.text()).toContain("no candidate named nope");
    expect(await wrapCommand(["--component", "Banner"], t.d)).toBe(0);
    const page = readFileSync(join(root, "app/page.tsx"), "utf8");
    expect(page).toContain('id="home-banner"');
    expect(page).toContain('<Hero title="Ship faster"');
    expect(page).toContain('import { Hero } from "../components/hero";');

    // A second run adds Hero to the existing sibling file and the existing imports.
    expect(await wrapCommand(["--component", "Hero"], t.d)).toBe(0);
    const sib = readFileSync(join(root, "components/hero.evolve.ts"), "utf8");
    expect(sib.match(/import \{ optimizable \}/g)).toHaveLength(1);
    expect(sib).toContain("export const OptimizableBanner = optimizable(Banner, bannerSchema);");
    expect(sib).toContain("export const OptimizableHero = optimizable(Hero, heroSchema);");
    const page2 = readFileSync(join(root, "app/page.tsx"), "utf8");
    expect(page2).not.toContain('../components/hero"');
    expect(page2).toContain('id="home-hero"');
    expect(page2.match(/from "next-evolve"/g)).toHaveLength(1);
  });

  it("asks which to wrap and to confirm when interactive", async () => {
    const root = app();
    const before = tree(root);
    const answers = ["9", "2", "n"];
    const asked: string[] = [];
    const t = deps(root, {
      ask: async (q) => {
        asked.push(q);
        return answers.shift()!;
      },
    });
    expect(await wrapCommand([], t.d)).toBe(0);
    expect(asked).toHaveLength(3); // bad pick, pick, confirm
    expect(t.text()).toContain("No changes written.");
    expect(tree(root)).toEqual(before);
  });

  it("without a terminal it needs --yes or --component", async () => {
    const t = deps(app());
    expect(await wrapCommand([], t.d)).toBe(1);
    expect(t.text()).toContain("pass --yes");
  });

  it("local components of the page get their schema in the page", async () => {
    const root = app({
      "app/page.tsx": `function Intro({ heading }: { heading: string }) {
  return <h2>{heading}</h2>;
}

export default function Home() {
  return <Intro heading="Why" />;
}
`,
    });
    const t = deps(root);
    expect(await wrapCommand(["--yes"], t.d)).toBe(0);
    expect(readFileSync(join(root, "app/page.tsx"), "utf8")).toMatchSnapshot();
  });

  it("with cacheComponents, each <Optimizable> gets a <Suspense> boundary", async () => {
    const root = app({ "next.config.ts": "export default { cacheComponents: true };\n" });
    const t = deps(root);
    expect(await wrapCommand(["--component", "Hero"], t.d)).toBe(0);
    const page = readFileSync(join(root, "app/page.tsx"), "utf8");
    expect(page).toContain('import { Suspense } from "react";');
    expect(page).toContain(`      <Suspense>
        <Optimizable
          id="home-hero"`);
    expect(page).toContain("      </Suspense>");
  });

  it("needs next-evolve and zod", async () => {
    const root = app({ "package.json": JSON.stringify({ dependencies: { next: "16.4.3" } }) });
    const t = deps(root);
    expect(await wrapCommand(["--yes"], t.d)).toBe(1);
    expect(t.text()).toContain("npx next-evolve init");
  });
});

describe("helpers", () => {
  it("parsePick: numbers, ranges, all, Enter = recommended, invalid = null", () => {
    const list = [
      { id: "a", recommended: true },
      { id: "b", recommended: false },
      { id: "c", recommended: true },
    ] as Candidate[];
    const ids = (p: Candidate[] | null) => p?.map((c) => c.id) ?? null;
    expect(ids(parsePick("", list))).toEqual(["a", "c"]);
    expect(ids(parsePick("all", list))).toEqual(["a", "b", "c"]);
    expect(ids(parsePick("2", list))).toEqual(["b"]);
    expect(ids(parsePick("3, 1", list))).toEqual(["a", "c"]);
    expect(ids(parsePick("1-2", list))).toEqual(["a", "b"]);
    expect(ids(parsePick("none", list))).toEqual([]);
    expect(parsePick("4", list)).toBeNull();
    expect(parsePick("x", list)).toBeNull();
  });

  it("tscErrorFiles reads the files tsc blames", () => {
    expect(
      tscErrorFiles(
        "app/page.tsx(3,5): error TS2322: x\ncomponents/a.evolve.ts(1,1): error TS2307: y\n  more\n",
      ),
    ).toEqual(["app/page.tsx", "components/a.evolve.ts"]);
  });
});
