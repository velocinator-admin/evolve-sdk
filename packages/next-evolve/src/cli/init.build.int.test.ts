// T11.2 acceptance: init on a fresh app (against the fake cloud) → `next build` passes.
// The app lives inside apps/fixture so next, react and next-evolve resolve from its node_modules.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_WEBHOOK_SECRET,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { project } from "../../test/project";

const FIXTURE = resolve(__dirname, "../../../../apps/fixture");
const CLI = resolve(__dirname, "../../dist/cli/index.js");
const NEXT = join(FIXTURE, "node_modules/.bin/next");

let cloud: FakeCloud;
let dir: string;
beforeAll(async () => {
  cloud = await startFakeCloud();
  dir = join(FIXTURE, `.init-build-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A create-next-app style app (TypeScript, app/). */
export function freshNextApp(at: string, pages: Record<string, string> = {}) {
  return project(
    {
      "package.json": JSON.stringify({
        name: "fresh",
        private: true,
        scripts: { build: "next build" },
        dependencies: {
          next: "16.4.3",
          react: "19.3.1",
          "react-dom": "19.3.1",
          "next-evolve": "*",
          zod: "^4.6.7",
        },
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "esnext"],
          jsx: "react-jsx",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
          allowJs: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] },
        },
        include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      }),
      ".env.local": "MY_OWN=1\n",
      "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
`,
      "app/page.tsx": "export default function Home() {\n  return <h1>Home</h1>;\n}\n",
      ...pages,
    },
    at,
  );
}

/** Runs a command without blocking this process (the fake cloud answers from here). */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

export function runCli(cwd: string, args: string[], cloudUrl: string) {
  return exec(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      EVOLVE_CLOUD_URL: cloudUrl,
      EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
      EVOLVE_DATABASE_URL: "",
      DATABASE_URL: "",
    },
  });
}

describe("init → next build (fresh app)", () => {
  it("builds, and the app's own env lines are untouched", { timeout: 240_000 }, async () => {
    freshNextApp(dir);
    const init = await runCli(
      dir,
      [
        "init",
        "--yes",
        "--key",
        TEST_SECRET_KEY,
        "--webhook-secret",
        TEST_WEBHOOK_SECRET,
        "--routes",
        "/",
      ],
      cloud.url,
    );
    expect(init.status, init.stderr + init.stdout).toBe(0);
    expect(readFileSync(join(dir, ".env.local"), "utf8").startsWith("MY_OWN=1\n")).toBe(true);

    const build = await exec(NEXT, ["build"], {
      cwd: dir,
      env: { ...process.env, NODE_ENV: "production" },
    });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    expect(build.stdout).toContain("Proxy");
    expect(existsSync(join(dir, ".evolve/bundle.generated.ts"))).toBe(true);
  });
});
