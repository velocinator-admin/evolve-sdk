// T22.4 acceptance (SDK-5, M17): `next-evolve wrap` on the corpus. The corpus
// builds as-is; each candidate is wrapped on its own (real tsc), the share that
// passes must be ≥ 80%, and the wrapped app must pass `next build`. A real tsc
// failure leaves every file byte-identical. The app lives inside apps/fixture
// so next, react, zod and next-evolve resolve from its node_modules.
import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTypescript } from "./pages";
import { detectCandidates } from "./wrap-detect";

const FIXTURE = resolve(__dirname, "../../../../apps/fixture");
const CORPUS = resolve(__dirname, "../../test/wrap-corpus");
const CLI = resolve(__dirname, "../../dist/cli/index.js");
const NEXT = join(FIXTURE, "node_modules/.bin/next");

function exec(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number | null; output: string }>((done) => {
    const child = spawn(cmd, args, { cwd, env });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (status) => done({ status, output }));
  });
}
const build = (cwd: string) =>
  exec(NEXT, ["build"], cwd, { ...process.env, NODE_ENV: "production" });
const wrap = (cwd: string, args: string[]) => exec(process.execPath, [CLI, "wrap", ...args], cwd);

/** Source files → bytes (build output and tool caches left out). */
function tree(root: string, dir = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(root, dir))) {
    if (
      e === ".next" ||
      e === "node_modules" ||
      e.endsWith(".tsbuildinfo") ||
      e === "next-env.d.ts"
    )
      continue;
    const p = dir ? `${dir}/${e}` : e;
    if (statSync(join(root, p)).isDirectory()) Object.assign(out, tree(root, p));
    else out[p] = readFileSync(join(root, p)).toString("base64");
  }
  return out;
}

let dir: string;
beforeAll(() => {
  dir = join(FIXTURE, `.init-wrap-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(CORPUS, dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "wrap-corpus",
      private: true,
      dependencies: {
        next: "16.4.3",
        react: "19.3.1",
        "react-dom": "19.3.1",
        "next-evolve": "*",
        zod: "^4.6.7",
      },
    }),
  );
  writeFileSync(join(dir, "next.config.mjs"), "export default {};\n");
  // Its own proxy, so Next doesn't pick up the fixture's (one folder up).
  writeFileSync(
    join(dir, "proxy.ts"),
    'import { NextResponse } from "next/server";\n\nexport function proxy() {\n  return NextResponse.next();\n}\n\nexport const config = { matcher: ["/__none"] };\n',
  );
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("wrap on the corpus → tsc + next build", () => {
  it("the corpus builds as-is", { timeout: 240_000 }, async () => {
    const r = await build(dir);
    expect(r.status, r.output).toBe(0);
  });

  it("≥ 80% of the candidates wrap with tsc passing, and the result builds", {
    timeout: 600_000,
  }, async () => {
    const d = detectCandidates(loadTypescript(dir)!, dir, "app");
    if ("error" in d) throw new Error(d.error);
    const todo = d.candidates.map((c) => ({ id: c.id, route: c.route, file: c.source.file }));
    expect(todo.length).toBeGreaterThanOrEqual(12);

    const failed: string[] = [];
    for (const [i, c] of todo.entries()) {
      const last = i === todo.length - 1;
      const r = await wrap(dir, [
        c.route,
        "--component",
        c.id,
        "--yes",
        ...(last ? ["--build"] : []),
      ]);
      if (r.status !== 0) failed.push(`${c.id} (${c.file}): ${r.output.slice(-600)}`);
    }
    const passed = todo.length - failed.length;
    console.warn(
      `wrap corpus: ${passed}/${todo.length} pass tsc${failed.length ? `\n${failed.join("\n")}` : ""}`,
    );
    expect(passed / todo.length).toBeGreaterThanOrEqual(0.8);

    const r = await build(dir);
    expect(r.status, r.output).toBe(0);
    // Nothing left to wrap: every candidate is now an <Optimizable>.
    const again = await wrap(dir, ["--dry-run", "--yes"]);
    expect(again.output).toContain("Nothing to wrap");
  });

  it("a tsc failure after writing leaves every file byte-identical", {
    timeout: 120_000,
  }, async () => {
    mkdirSync(join(dir, "app/broken"), { recursive: true });
    writeFileSync(
      join(dir, "app/broken/page.tsx"),
      `import { Hero } from "../../components/hero";

const count: number = "not a number";

export default function Broken() {
  return <Hero title={\`Count \${count}\`} ctaLabel="Go" ctaHref="/" />;
}
`,
    );
    const before = tree(dir);
    const r = await wrap(dir, ["/broken", "--yes"]);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("every file is restored");
    expect(tree(dir)).toEqual(before);
  });
});
