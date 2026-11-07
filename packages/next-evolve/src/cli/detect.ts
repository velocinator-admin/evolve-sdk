// `init` step 1 (spec §16.1): what kind of app is this?
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";
export type Problem = { level: "error" | "warn"; message: string };

export type Detection = {
  root: string;
  /** Installed version, else the declared one (range stripped). */
  nextVersion: string | null;
  /** `app` or `src/app`. */
  appDir: string | null;
  srcDir: boolean;
  typescript: boolean;
  packageManager: PackageManager;
  /** Existing proxy/middleware file, relative to root. */
  proxyFile: string | null;
  /** What Next calls it: `proxy.ts` from 16, `middleware.ts` (runtime nodejs) on 15.5. */
  proxyKind: "proxy" | "middleware";
  nextConfigFile: string | null;
  outputExport: boolean;
  cacheComponents: boolean;
  hasEvolve: boolean;
  hasZod: boolean;
  problems: Problem[];
};

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

function parseVersion(v: string | null | undefined): [number, number] | null {
  const m = /(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function detectProject(root: string): Detection {
  const problems: Problem[] = [];
  const pkgText = read(join(root, "package.json"));
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = pkgText ? JSON.parse(pkgText) : {};
  } catch {
    problems.push({ level: "error", message: "package.json isn't valid JSON" });
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };

  const installed = read(join(root, "node_modules/next/package.json"));
  let nextVersion: string | null = null;
  try {
    nextVersion = installed ? (JSON.parse(installed).version as string) : null;
  } catch {}
  if (!nextVersion && deps.next) {
    const v = parseVersion(deps.next);
    nextVersion = v ? `${v[0]}.${v[1]}.0` : deps.next;
  }
  const ver = parseVersion(nextVersion);

  const appDir = existsSync(join(root, "src/app"))
    ? "src/app"
    : existsSync(join(root, "app"))
      ? "app"
      : null;
  const srcDir = appDir === "src/app";

  const packageManager: PackageManager = existsSync(join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(root, "yarn.lock"))
      ? "yarn"
      : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))
        ? "bun"
        : "npm";

  const base = srcDir ? "src/" : "";
  const proxyFile =
    ["proxy", "middleware"]
      .flatMap((n) => ["ts", "js", "mjs", "tsx"].map((e) => `${base}${n}.${e}`))
      .find((f) => existsSync(join(root, f))) ?? null;

  const nextConfigFile =
    ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"].find((f) =>
      existsSync(join(root, f)),
    ) ?? null;
  const nextConfig = nextConfigFile ? (read(join(root, nextConfigFile)) ?? "") : "";
  const outputExport = /output\s*:\s*["'`]export["'`]/.test(nextConfig);
  const cacheComponents = /cacheComponents\s*:\s*true/.test(nextConfig);

  if (!deps.next && !installed) {
    problems.push({
      level: "error",
      message: "This isn't a Next.js app (no next in package.json)",
    });
  } else if (!ver || ver[0] < 15 || (ver[0] === 15 && ver[1] < 5)) {
    problems.push({
      level: "error",
      message: `Evolve needs Next.js 15.5 or newer (found ${nextVersion ?? "unknown"})`,
    });
  }
  if (deps.next && !appDir) {
    problems.push({ level: "error", message: "Evolve needs the App Router (no app/ directory)" });
  }
  if (outputExport) {
    problems.push({
      level: "error",
      message: 'output: "export" builds a static site; Evolve needs a server (remove it)',
    });
  }
  // cacheComponents is supported (T23.3, HOST-2): dynamic mode wraps
  // <Optimizable> in <Suspense>; static mode caches each variant code with
  // "use cache" (doctor's Pages check enforces the page shape).

  return {
    root,
    nextVersion,
    appDir,
    srcDir,
    typescript: existsSync(join(root, "tsconfig.json")),
    packageManager,
    proxyFile,
    proxyKind: ver && ver[0] >= 16 ? "proxy" : "middleware",
    nextConfigFile,
    outputExport,
    cacheComponents,
    hasEvolve: Boolean(deps["next-evolve"]),
    hasZod: Boolean(deps.zod),
    problems,
  };
}
