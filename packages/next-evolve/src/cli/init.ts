// `npx next-evolve init` (spec §16.1). Detects the app, connects it to the
// site, sets up the database, writes the files and pushes the manifest.
// Idempotent: a re-run plans nothing it already did. `--dry-run` prints the
// diff and changes nothing (no install, no migration, no cloud writes).
import { spawn } from "node:child_process";
import { parseSecretKey, WEBHOOK_SECRET_RE } from "@next-evolve/protocol";
import { compilePattern, isPattern } from "../core/routes";
import { createSql } from "../db/client";
import { migrate } from "../db/migrate";
import { parseFlags } from "./args";
import { getSiteInfo, putAppUrl } from "./cloud";
import { type Detection, detectProject } from "./detect";
import { fileEnv } from "./env-file";
import {
  newTrackSecret,
  planConfig,
  planEnv,
  planGitignore,
  planGoals,
  planInstrumentation,
  planLayout,
  planNextConfig,
  planPackageJson,
  planProxy,
  planRouteHandler,
  type RouteMode,
} from "./files";
import { planPages } from "./pages";
import { Plan, renderDiff } from "./plan";
import { pullCommand } from "./pull";
import { pushCommand } from "./push";

type Env = Record<string, string | undefined>;

export type InitDeps = {
  env: Env;
  cwd?: string;
  fetch?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Asks a question (interactive); null when there's no terminal. */
  ask?: ((q: string) => Promise<string>) | null;
  /** Runs a command (install). */
  run?: (cmd: string, args: string[], cwd: string) => Promise<number>;
  /** Tests the DB and migrates it. */
  setupDb?: (
    url: string,
  ) => Promise<{ ok: true; applied: string[] } | { ok: false; error: string }>;
  /** Runs `push` (tests can skip). */
  push?: (env: Env) => Promise<number>;
};

const FLAGS = {
  key: { type: "string" },
  "webhook-secret": { type: "string" },
  db: { type: "string" },
  "app-url": { type: "string" },
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  mode: { type: "string" },
  routes: { type: "string" },
  "cdn-routing": { type: "boolean" },
} as const;

const DB_HELP = `Evolve stores events in your own Postgres (its own "evolve" schema).
  One-click options:
    Vercel Marketplace → Neon:  https://vercel.com/marketplace/neon
    Supabase:                   https://supabase.com/dashboard/new
    Neon:                       https://console.neon.tech/signup`;

export async function initCommand(args: string[], deps: InitDeps): Promise<number> {
  const out = deps.out ?? ((s) => console.warn(s));
  const err = deps.err ?? ((s) => console.error(s));
  const cwd = deps.cwd ?? process.cwd();
  const p = parseFlags(args, FLAGS);
  if (!p.ok) {
    err(`next-evolve init: ${p.error}`);
    return 1;
  }
  const f = p.flags;
  const dry = Boolean(f["dry-run"]);
  const yes = Boolean(f.yes);
  const ask = deps.ask === undefined ? null : deps.ask;
  const env: Env = { ...fileEnv(cwd), ...deps.env };

  // 1. Detect
  const d = detectProject(cwd);
  for (const pr of d.problems)
    (pr.level === "error" ? err : out)(`${pr.level === "error" ? "✗" : "!"} ${pr.message}`);
  if (d.problems.some((pr) => pr.level === "error")) return 1;
  out(
    `✓ Next.js ${d.nextVersion} · ${d.appDir}/ · ${d.typescript ? "TypeScript" : "JavaScript"} · ${d.packageManager}`,
  );

  // cacheComponents (on in new create-next-app projects) rejects the segment
  // config static mode writes (revalidate, dynamicParams), so use dynamic.
  const mode = f.mode ?? (d.cacheComponents ? "dynamic" : "static");
  if (mode !== "static" && mode !== "dynamic") {
    err('next-evolve init: --mode is "static" or "dynamic"');
    return 1;
  }
  if (d.cacheComponents && mode === "static") {
    err(
      "✗ cacheComponents is on, and static mode doesn't work with it: use --mode dynamic (the default with cacheComponents)",
    );
    return 1;
  }
  const cdn = Boolean(f["cdn-routing"]);
  if (cdn && mode !== "static") {
    err(
      "✗ --cdn-routing needs static routes (dynamic routes always run the proxy): drop --mode dynamic, or drop --cdn-routing",
    );
    return 1;
  }
  const paths = (f.routes ?? "/").split(/[\s,]+/).filter(Boolean);
  const badRoute = (r: string) =>
    !r.startsWith("/") ||
    (isPattern(r) ? typeof compilePattern(r) === "string" : /[[\]*?#:]/.test(r));
  if (paths.some(badRoute)) {
    err('next-evolve init: --routes are paths or patterns like "/ /pricing /lp/:slug"');
    return 1;
  }

  // 3. Connect (read-only, so dry runs do it too)
  const need = async (
    label: string,
    flag: string | undefined,
    envKey: string,
    valid: (v: string) => boolean,
  ) => {
    let v = flag ?? env[envKey];
    if (!v && ask && !yes) v = (await ask(`${label}: `)).trim();
    if (!v || !valid(v)) return null;
    return v;
  };
  const key = await need("Secret key (evk_live_…)", f.key, "EVOLVE_SECRET_KEY", (v) =>
    Boolean(parseSecretKey(v)),
  );
  if (!key) {
    err("✗ A secret key is needed: --key evk_live_… (shown once when you created the site)");
    return 1;
  }
  const webhookSecret = await need(
    "Webhook secret (whsec_…)",
    f["webhook-secret"],
    "EVOLVE_WEBHOOK_SECRET",
    (v) => WEBHOOK_SECRET_RE.test(v),
  );
  if (!webhookSecret) {
    err("✗ The webhook secret is needed: --webhook-secret whsec_…");
    return 1;
  }
  const site = await getSiteInfo({ env, fetch: deps.fetch }, key);
  if (!site.ok) {
    err(`✗ ${site.error}`);
    return 1;
  }
  out(`✓ Connected to "${site.site.name}" (${site.site.id})`);

  // 2. Install
  const missing = [...(d.hasEvolve ? [] : ["next-evolve"]), ...(d.hasZod ? [] : ["zod@^4"])];
  if (missing.length) {
    if (dry) out(`  would install ${missing.join(" ")}`);
    else {
      const [cmd, ...a] = installCommand(d, missing);
      out(`  ${cmd} ${a.join(" ")}`);
      const code = await (deps.run ?? runCommand)(cmd!, a, cwd);
      if (code !== 0) {
        err(`✗ Install failed (exit ${code})`);
        return 1;
      }
    }
  }

  // 4. Database
  let dbUrl = f.db ?? env.EVOLVE_DATABASE_URL ?? null;
  if (!dbUrl) {
    const reuse = env.DATABASE_URL ? "DATABASE_URL" : env.POSTGRES_URL ? "POSTGRES_URL" : null;
    if (reuse) {
      const ok =
        yes ||
        !ask ||
        /^(y|yes|)$/i.test(
          (await ask(`Use ${reuse} for Evolve's events (own "evolve" schema)? [Y/n] `)).trim(),
        );
      if (ok) dbUrl = env[reuse]!;
    }
    if (!dbUrl && ask && !yes) {
      out(DB_HELP);
      dbUrl = (await ask("Postgres URL (empty to skip for now): ")).trim() || null;
    }
  }
  if (!dbUrl) {
    out(
      `! No database yet: variants serve, but nothing is measured.\n${DB_HELP}\n  Then: set EVOLVE_DATABASE_URL and run npx next-evolve migrate`,
    );
  } else if (dry) out("  would test the database and run migrations");
  else {
    const r = await (deps.setupDb ?? setupDatabase)(dbUrl);
    if (!r.ok) {
      err(`✗ Database: ${r.error}`);
      return 1;
    }
    out(`✓ Database ready${r.applied.length ? ` (applied ${r.applied.join(", ")})` : ""}`);
  }

  // 5–11. Files
  const plan = new Plan(cwd);
  const routes: RouteMode[] = paths.map((path) => ({ path, mode }));
  const finalRoutes = planPages(plan, d, routes);
  planConfig(plan, d, finalRoutes, cdn);
  planGoals(plan, d);
  planRouteHandler(plan, d);
  planProxy(plan, d, finalRoutes, cdn);
  if (cdn) planNextConfig(plan, d);
  planLayout(plan, d);
  planInstrumentation(plan, d);
  planPackageJson(plan);
  planGitignore(plan);
  const added = planEnv(plan, {
    EVOLVE_SECRET_KEY: key,
    EVOLVE_WEBHOOK_SECRET: webhookSecret,
    EVOLVE_DATABASE_URL: dbUrl ?? undefined,
    EVOLVE_TRACK_SECRET: env.EVOLVE_TRACK_SECRET ?? newTrackSecret(),
  });

  const changes = plan.changes();
  if (dry) {
    out(changes.length ? `\nWould change:\n\n${renderDiff(changes)}` : "\nNothing to change.");
  } else {
    plan.apply();
    for (const c of changes)
      out(
        `  ${c.before === null ? "created" : c.after === null ? "removed" : "updated"} ${c.path}`,
      );
    if (!changes.length) out("  files already set up");
  }
  for (const n of plan.notes) out(`  ${n}`);

  // 10, 12, 13: build bundle, app URL, manifest
  const appEnv: Env = { ...env, EVOLVE_SECRET_KEY: key, EVOLVE_WEBHOOK_SECRET: webhookSecret };
  if (!dry) {
    await pullCommand([], { env: appEnv, cwd, out: () => {}, err: () => {} });
    if (f["app-url"]) {
      const r = await putAppUrl({ env, fetch: deps.fetch }, key, f["app-url"]);
      if (r.ok) out(`✓ App URL: ${r.appUrl}`);
      else err(`! App URL not set: ${r.error}`);
    }
    const pushed = await (
      deps.push ??
      ((e) => pushCommand([], { env: e, cwd, out: () => {}, err: () => {}, quiet: true }))
    )(appEnv);
    out(
      pushed === 0 ? "✓ Manifest sent" : "! Manifest not sent yet (it's sent when your app starts)",
    );
  } else if (f["app-url"]) out(`  would register the app URL ${f["app-url"]}`);

  // 14. Next steps
  const steps = [
    ...plan.manual,
    ...(added.length && !dry
      ? [`In production, set ${added.join(", ")} (they're in .env.local now)`]
      : []),
    d.cacheComponents
      ? `Wrap a component: <Suspense><Optimizable id="hero" component={Hero} props={...} /></Suspense> (Optimizable from "next-evolve"; cacheComponents needs the <Suspense>)`
      : `Wrap a component: <Optimizable id="hero" component={Hero} props={...} /> (from "next-evolve")`,
    "Visit the page once so the region registers, then open the dashboard",
    ...(f["app-url"]
      ? ["After you deploy: npx next-evolve connect --test"]
      : ["After you deploy: npx next-evolve connect --test --app-url https://your-app.com"]),
  ];
  out(`\nNext:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`);
  return 0;
}

export function installCommand(d: Detection, pkgs: string[]): string[] {
  switch (d.packageManager) {
    case "pnpm":
      return ["pnpm", "add", ...pkgs];
    case "yarn":
      return ["yarn", "add", ...pkgs];
    case "bun":
      return ["bun", "add", ...pkgs];
    default:
      return ["npm", "install", ...pkgs];
  }
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function setupDatabase(
  url: string,
): Promise<{ ok: true; applied: string[] } | { ok: false; error: string }> {
  const sql = createSql(url, { max: 1 });
  try {
    await sql`select 1`;
    const r = await migrate(sql);
    return { ok: true, applied: r.applied };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
