// `next-evolve doctor` (spec §16.2): checks the setup end to end and says
// what to fix. Exit 1 when a check fails (warnings don't fail).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSecretKey, verifyBundle } from "@next-evolve/protocol";
import { type EvolveConfig, normalizePath } from "../config/config";
import { trustedKeys } from "../core/keys";
import { createSql } from "../db/client";
import { loadMigrations } from "../db/migrate";
import { fetchBundle } from "../store/fetch";
import { cloudUrl, getSiteInfo, runCloudTest } from "./cloud";
import { detectProject } from "./detect";
import { fileEnv } from "./env-file";
import { type AppModules, loadAppModules, reexecWithTypes } from "./load-app";
import { BUILD_BUNDLE_PATH, readBuildBundle } from "./pull";

type Env = Record<string, string | undefined>;

export type Check = { name: string; status: "ok" | "warn" | "fail"; detail?: string };

export type DoctorDeps = {
  env: Env;
  cwd?: string;
  fetch?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Milliseconds (tests move the clock). */
  now?: () => number;
  /** The app's config (tests); default loads evolve.config. */
  load?: () => Promise<AppModules>;
  /** Reachable and migrated? Default connects with the app's DB URL. */
  checkDb?: (
    url: string,
  ) => Promise<{ ok: true; pending: string[] } | { ok: false; error: string }>;
  /** Override the app URL the cloud has (tests); default from GET /v1/site. */
  appUrl?: string | null;
};

const DAY = 86_400;
const ok = (name: string, detail?: string): Check => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): Check => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });

/** Next matcher (path-to-regexp style) → RegExp; null when it can't be read. */
function matcherRegex(m: string): RegExp | null {
  try {
    const s = m
      .replace(/\/:\w+\*/g, "(?:/.*)?")
      .replace(/\/:\w+\+/g, "(?:/.+)")
      .replace(/\/:\w+\?/g, "(?:/[^/]+)?")
      .replace(/:\w+/g, "[^/]+");
    return new RegExp(`^${s}$`);
  } catch {
    return null;
  }
}

/** The string literals in `config.matcher`, or null when there's no matcher (= every path). */
export function readMatcher(src: string): string[] | null {
  const m = /matcher\s*:\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*'|`[^`]*`)/.exec(src);
  if (!m) return null;
  return [...m[1]!.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]!);
}

export const covers = (matchers: string[] | null, path: string) =>
  matchers === null || matchers.some((m) => m === path || matcherRegex(m)?.test(path));

function dirs(root: string, dir: string): string[] {
  try {
    return readdirSync(join(root, dir)).filter((e) => statSync(join(root, dir, e)).isDirectory());
  } catch {
    return [];
  }
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const cwd = deps.cwd ?? process.cwd();
  const env: Env = { ...fileEnv(cwd), ...deps.env };
  const nowMs = (deps.now ?? Date.now)();
  const checks: Check[] = [];
  const d = detectProject(cwd);

  // Next.js
  const errors = d.problems.filter((p) => p.level === "error");
  const warns = d.problems.filter((p) => p.level === "warn");
  checks.push(
    errors.length
      ? fail("Next.js", errors.map((p) => p.message).join("; "))
      : warns.length
        ? warn("Next.js", warns.map((p) => p.message).join("; "))
        : ok("Next.js", `${d.nextVersion} · ${d.appDir}/`),
  );

  // Env vars
  const required = ["EVOLVE_SECRET_KEY", "EVOLVE_WEBHOOK_SECRET"].filter((k) => !env[k]);
  const optional = ["EVOLVE_DATABASE_URL", "EVOLVE_TRACK_SECRET"].filter((k) => !env[k]);
  checks.push(
    required.length
      ? fail("Env vars", `missing ${required.join(", ")}`)
      : optional.length
        ? warn("Env vars", `missing ${optional.join(", ")}`)
        : ok("Env vars"),
  );

  // Secret key
  const key = env.EVOLVE_SECRET_KEY ?? "";
  const parsed = parseSecretKey(key);
  let appUrl: string | null = deps.appUrl === undefined ? null : deps.appUrl;
  let keyOk = false;
  if (!parsed) checks.push(fail("Secret key", "EVOLVE_SECRET_KEY isn't an evk_live_… key"));
  else {
    const site = await getSiteInfo({ env, fetch: deps.fetch }, key);
    if (!site.ok) checks.push(fail("Secret key", site.error));
    else {
      keyOk = true;
      if (deps.appUrl === undefined) appUrl = site.site.appUrl;
      checks.push(ok("Secret key", `"${site.site.name}" (${site.site.id})`));
    }
  }

  // Database
  const dbUrl = env.EVOLVE_DATABASE_URL;
  if (!dbUrl)
    checks.push(
      warn("Database", "EVOLVE_DATABASE_URL isn't set: variants serve, nothing is measured"),
    );
  else {
    const r = await (deps.checkDb ?? checkDatabase)(dbUrl);
    checks.push(
      !r.ok
        ? fail("Database", r.error)
        : r.pending.length
          ? fail("Database", `not migrated (${r.pending.join(", ")}): run npx next-evolve migrate`)
          : ok("Database", "reachable and migrated"),
    );
  }

  // Bundle: the cloud's current one is valid and not close to expiring.
  const now = Math.floor(nowMs / 1000);
  if (!keyOk || !parsed) checks.push(fail("Bundle", "needs a working secret key"));
  else {
    const res = await fetchBundle({
      cloudUrl: cloudUrl(env),
      secretKey: key,
      timeoutMs: 10_000,
      fetch: deps.fetch,
    });
    if (res.status !== "ok") checks.push(fail("Bundle", "couldn't fetch the bundle"));
    else {
      const v = verifyBundle(res.token, { keys: trustedKeys(env), site: parsed.siteId, now });
      const days = v.ok ? Math.floor((v.payload.exp - now) / DAY) : 0;
      const build = read(join(cwd, BUILD_BUNDLE_PATH));
      if (!v.ok) checks.push(fail("Bundle", `rejected (${v.reason})`));
      else if (v.payload.exp - now < 7 * DAY)
        checks.push(
          fail(
            "Bundle",
            `expires in ${days} day(s); the cloud re-signs daily, so check its cron/status`,
          ),
        );
      else if (!build || !readBuildBundle(build))
        checks.push(
          warn(
            "Bundle",
            `no ${BUILD_BUNDLE_PATH}: add "prebuild": "next-evolve pull" (cold starts serve control)`,
          ),
        );
      else checks.push(ok("Bundle", `ver ${v.payload.ver}, expires in ${days} days`));
    }
  }

  // Routes from the app's config
  let config: EvolveConfig | null = null;
  let configError: string | null = null;
  try {
    if (deps.load) config = (await deps.load()).config;
    else {
      const r = await loadAppModules(cwd);
      if (r.ok) config = r.mods.config;
      else configError = r.error;
    }
  } catch (e) {
    configError = e instanceof Error ? e.message : String(e);
  }
  const routes = config
    ? Object.entries(config.routes ?? {}).map(([p, r]) => ({
        path: normalizePath(p),
        mode: r.mode,
      }))
    : [];

  // Proxy matcher ⊇ routes ∪ /(ev_.*)
  if (!d.proxyFile) checks.push(fail("Proxy matcher", `no proxy (${d.proxyKind}.ts) file`));
  else {
    const src = read(join(cwd, d.proxyFile)) ?? "";
    if (!src.includes("next-evolve")) {
      checks.push(fail("Proxy matcher", `${d.proxyFile} doesn't run Evolve (applyEvolve)`));
    } else {
      const matchers = readMatcher(src);
      const missing = [
        ...routes.filter((r) => !covers(matchers, r.path)).map((r) => r.path),
        ...(covers(matchers, "/ev_0") ? [] : ["/(ev_.*)"]),
      ];
      checks.push(
        missing.length
          ? fail("Proxy matcher", `config.matcher in ${d.proxyFile} misses ${missing.join(", ")}`)
          : ok("Proxy matcher"),
      );
    }
  }

  // Pages: static routes wrapped under [evolve]; no conflicting top-level segment.
  const app = d.appDir ?? "app";
  if (!config) checks.push(fail("Pages", configError ?? "couldn't load evolve.config"));
  else {
    const problems: string[] = [];
    const statics = routes.filter((r) => r.mode === "static");
    const clash = dirs(cwd, app).find((x) => /^\[.+\]$/.test(x) && x !== "[evolve]");
    if (statics.length && clash)
      problems.push(`${app}/${clash} conflicts with ${app}/[evolve]; use "dynamic" mode`);
    for (const r of statics) {
      const seg = r.path === "/" ? "" : r.path;
      const page = ["tsx", "jsx", "ts", "js"]
        .map((e) => `${app}/[evolve]${seg}/page.${e}`)
        .find((f) => existsSync(join(cwd, f)));
      if (!page) problems.push(`${r.path}: no ${app}/[evolve]${seg}/page (run init again)`);
      else if (!read(join(cwd, page))?.includes("withEvolve"))
        problems.push(`${r.path}: ${page} isn't wrapped with withEvolve()`);
    }
    checks.push(problems.length ? fail("Pages", problems.join("; ")) : ok("Pages"));
  }

  // EvolveScript in the root layout
  const layout = ["tsx", "jsx", "js", "ts"]
    .map((e) => `${app}/layout.${e}`)
    .find((f) => existsSync(join(cwd, f)));
  checks.push(
    layout && read(join(cwd, layout))?.includes("EvolveScript")
      ? ok("EvolveScript")
      : fail(
          "EvolveScript",
          `add <EvolveScript /> (next-evolve/client) to ${layout ?? "the root layout"}`,
        ),
  );

  // Cloud → app (sync + aggregate routes)
  if (!keyOk) checks.push(fail("Cloud → app", "needs a working secret key"));
  else if (!appUrl)
    checks.push(
      warn(
        "Cloud → app",
        "no app URL yet; after you deploy: npx next-evolve connect --test --app-url https://…",
      ),
    );
  else {
    const t = await runCloudTest({ env, fetch: deps.fetch }, key);
    if (!t.ok) checks.push(fail("Cloud → app", t.error));
    else {
      const bad = [
        ...(t.webhook.ok ? [] : [`sync route: ${t.webhook.detail ?? "failed"}`]),
        ...(t.aggregate.ok ? [] : [`aggregate route: ${t.aggregate.detail ?? "failed"}`]),
      ];
      checks.push(
        bad.length
          ? fail("Cloud → app", `${appUrl}: ${bad.join("; ")}`)
          : ok("Cloud → app", appUrl),
      );
    }
  }

  // CDN
  const onVercel = Boolean(env.VERCEL) || existsSync(join(cwd, ".vercel/project.json"));
  checks.push(
    onVercel
      ? ok("CDN", "Vercel")
      : warn(
          "CDN",
          "not on Vercel: if a CDN caches pages, it must not cache Evolve routes by URL alone (the variant comes from the evolve cookie)",
        ),
  );
  return checks;
}

async function checkDatabase(
  url: string,
): Promise<{ ok: true; pending: string[] } | { ok: false; error: string }> {
  const sql = createSql(url, { max: 1 });
  try {
    await sql`select 1`;
    const [t] = await sql<{ r: string | null }[]>`select to_regclass('evolve.migrations') as r`;
    const done = t?.r
      ? new Set((await sql<{ id: string }[]>`select id from evolve.migrations`).map((r) => r.id))
      : new Set<string>();
    const pending = (await loadMigrations()).map((m) => m.id).filter((id) => !done.has(id));
    return { ok: true, pending };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

export async function doctorCommand(args: string[], deps: DoctorDeps): Promise<number> {
  const out = deps.out ?? ((s) => console.warn(s));
  const cwd = deps.cwd ?? process.cwd();
  if (!deps.load) {
    const r = await loadAppModules(cwd);
    if (!r.ok && r.needsTs && process.argv[1])
      return reexecWithTypes("doctor", args, cwd, deps.env);
  }
  const checks = await runDoctor(deps);
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  for (const c of checks) out(`${mark[c.status]} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  out(failed ? `\n${failed} check(s) failed.` : "\nAll good.");
  return failed ? 1 : 0;
}
