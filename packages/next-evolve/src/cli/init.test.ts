import { existsSync, readFileSync } from "node:fs";
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
import { type InitDeps, initCommand } from "./init";

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
