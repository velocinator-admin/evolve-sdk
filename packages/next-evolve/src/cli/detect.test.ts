import { describe, expect, it } from "vitest";
import { project } from "../../test/project";
import { detectProject } from "./detect";

const pkg = (deps: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ name: "app", dependencies: deps, ...extra });
const installedNext = (v: string) => ({
  "node_modules/next/package.json": JSON.stringify({ name: "next", version: v }),
});

const errors = (d: ReturnType<typeof detectProject>) =>
  d.problems.filter((p) => p.level === "error").map((p) => p.message);
const warnings = (d: ReturnType<typeof detectProject>) =>
  d.problems.filter((p) => p.level === "warn").map((p) => p.message);

describe("detectProject (spec §16.1 step 1)", () => {
  it("Next 16, TypeScript, app/, pnpm, no proxy yet", () => {
    const d = detectProject(
      project({
        "package.json": pkg({ next: "^16.4.0", react: "19.3.1" }),
        ...installedNext("16.4.3"),
        "pnpm-lock.yaml": "",
        "tsconfig.json": "{}",
        "app/layout.tsx": "",
        "app/page.tsx": "",
        "next.config.ts": "export default {};",
      }),
    );
    expect(d).toMatchObject({
      nextVersion: "16.4.3",
      appDir: "app",
      srcDir: false,
      typescript: true,
      packageManager: "pnpm",
      proxyFile: null,
      proxyKind: "proxy",
      hasEvolve: false,
    });
    expect(d.problems).toEqual([]);
  });

  it("Next 15.5, src/app, yarn, an existing middleware.ts, next-evolve installed", () => {
    const d = detectProject(
      project({
        "package.json": pkg({ next: "15.5.2", "next-evolve": "^0.2.2" }),
        ...installedNext("15.5.2"),
        "yarn.lock": "",
        "tsconfig.json": "{}",
        "src/app/layout.tsx": "",
        "src/middleware.ts": "export function middleware() {}",
      }),
    );
    expect(d).toMatchObject({
      appDir: "src/app",
      srcDir: true,
      packageManager: "yarn",
      proxyFile: "src/middleware.ts",
      proxyKind: "middleware",
      hasEvolve: true,
    });
    expect(errors(d)).toEqual([]);
  });

  it("Next older than 15.5 → error", () => {
    const d = detectProject(
      project({
        "package.json": pkg({ next: "14.2.0" }),
        "app/layout.js": "",
        "package-lock.json": "",
      }),
    );
    expect(d.packageManager).toBe("npm");
    expect(d.typescript).toBe(false);
    expect(errors(d)).toEqual([expect.stringMatching(/Next\.js 15\.5 or newer.*14\.2/)]);
  });

  it("Pages Router only, or no Next at all → error", () => {
    const pages = detectProject(
      project({ "package.json": pkg({ next: "16.0.0" }), "pages/index.tsx": "" }),
    );
    expect(errors(pages)).toEqual([expect.stringMatching(/App Router/)]);
    const none = detectProject(project({ "package.json": pkg({ react: "19" }) }));
    expect(errors(none)[0]).toMatch(/isn't a Next\.js app/);
  });

  it("output: 'export' → error; cacheComponents → warning; bun lockfile", () => {
    const d = detectProject(
      project({
        "package.json": pkg({ next: "16.1.0" }),
        "bun.lock": "",
        "app/layout.tsx": "",
        "next.config.mjs": `export default { output: "export", cacheComponents: true };`,
      }),
    );
    expect(d.packageManager).toBe("bun");
    expect(d.outputExport).toBe(true);
    expect(d.cacheComponents).toBe(true);
    expect(errors(d)).toEqual([expect.stringMatching(/output: "export"/)]);
    expect(warnings(d)).toEqual([expect.stringMatching(/cacheComponents/)]);
  });
});
