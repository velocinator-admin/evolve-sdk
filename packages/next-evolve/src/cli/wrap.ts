// `npx next-evolve wrap [route]` (SDK-5, US-3.2): finds the components a
// page renders, generates a Zod schema from their TypeScript props, writes an
// `optimizable()` export and replaces the usage with `<Optimizable id>`.
// Shows the diff first. Writes are all-or-nothing: if `tsc` (or `next build`
// with --build) fails afterwards, every file is restored byte-identical.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { detectProject } from "./detect";
import { loadTypescript } from "./pages";
import { Plan, renderDiff } from "./plan";
import { type Candidate, detectCandidates } from "./wrap-detect";
import { planWrap } from "./wrap-rewrite";

export type VerifyStep = "tsc" | "next build";
export type VerifyResult = { ok: boolean; output: string };

export type WrapDeps = {
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Asks a question (interactive); null when there's no terminal. */
  ask?: ((q: string) => Promise<string>) | null;
  /** Runs a check after the files are written (tests inject failures). */
  verify?: (step: VerifyStep, root: string, changed: string[]) => Promise<VerifyResult>;
};

const FLAGS = {
  yes: { type: "boolean", short: "y" },
  "dry-run": { type: "boolean" },
  build: { type: "boolean" },
  component: { type: "string", short: "c" },
} as const;

export const WRAP_USAGE = "wrap [route] [--component <Name,…>] [--yes] [--dry-run] [--build]";

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; output: string }>((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", (e) => resolve({ status: 1, output: String(e) }));
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** A package's directory, resolved from the app (then from next-evolve). */
function pkgDir(root: string, name: string): string | null {
  for (const from of [join(root, "package.json"), import.meta.url]) {
    try {
      return dirname(createRequire(from).resolve(`${name}/package.json`));
    } catch {}
  }
  return null;
}

/** Parses `file(line,col): error TS…` lines; the files tsc reports errors in. */
export function tscErrorFiles(output: string): string[] {
  const files = new Set<string>();
  for (const m of output.matchAll(/^(.+?)\(\d+,\d+\): error TS\d+/gm))
    files.add(m[1]!.trim().replace(/\\/g, "/"));
  return [...files];
}

/**
 * Real checks. tsc: errors in files wrap changed fail; errors only elsewhere
 * were there before wrap and are reported, not blamed. next build: any failure.
 */
export async function defaultVerify(
  step: VerifyStep,
  root: string,
  changed: string[],
): Promise<VerifyResult> {
  if (step === "tsc") {
    const ts = pkgDir(root, "typescript");
    if (!ts) return { ok: false, output: "typescript isn't installed" };
    const r = await run(
      process.execPath,
      [join(ts, "bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
      root,
    );
    if (r.status === 0) return { ok: true, output: r.output };
    const files = tscErrorFiles(r.output);
    const blamed = files.filter((f) => changed.includes(f));
    if (files.length && blamed.length === 0)
      return {
        ok: true,
        output: `tsc reports errors only in files wrap didn't touch (${files.join(", ")}); not caused by wrap.`,
      };
    return { ok: false, output: r.output };
  }
  const next = pkgDir(root, "next");
  if (!next) return { ok: false, output: "next isn't installed" };
  const r = await run(process.execPath, [join(next, "dist/bin/next"), "build"], root, {
    ...process.env,
    NODE_ENV: "production",
  });
  return { ok: r.status === 0, output: r.output };
}

/** Parses the picker's answer: "1,3", "1-3", "all", "" (= recommended). Null when invalid. */
export function parsePick(answer: string, list: Candidate[]): Candidate[] | null {
  const a = answer.trim().toLowerCase();
  if (a === "") return list.filter((c) => c.recommended);
  if (a === "all" || a === "a") return list;
  if (a === "none" || a === "n" || a === "q") return [];
  const out = new Set<Candidate>();
  for (const part of a.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    for (let i = from; i <= to; i++) {
      const c = list[i - 1];
      if (!c) return null;
      out.add(c);
    }
  }
  return list.filter((c) => out.has(c));
}

function describe(c: Candidate, i: number): string {
  const editable = c.props.filter((p) => p.shape).map((p) => p.name);
  return `  ${String(i + 1).padStart(2)}. ${c.recommended ? "★" : " "} <${c.tag}> on ${c.route}  →  id "${c.id}"  (${editable.join(", ")})`;
}

export async function wrapCommand(args: string[], deps: WrapDeps = {}): Promise<number> {
  const out = deps.out ?? ((s) => console.warn(s));
  const err = deps.err ?? ((s) => console.error(s));
  const root = deps.cwd ?? process.cwd();
  const ask = deps.ask === undefined ? null : deps.ask;
  const verify = deps.verify ?? defaultVerify;

  let parsed: ReturnType<typeof parseArgs<{ options: typeof FLAGS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args, options: FLAGS, strict: true, allowPositionals: true });
  } catch (e) {
    err(`next-evolve wrap: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const f = parsed.values;
  if (parsed.positionals.length > 1) {
    err(`next-evolve wrap: one route at most (usage: ${WRAP_USAGE})`);
    return 1;
  }
  const route = parsed.positionals[0];
  const dry = Boolean(f["dry-run"]);

  const d = detectProject(root);
  for (const pr of d.problems.filter((p) => p.level === "error")) err(`✗ ${pr.message}`);
  if (d.problems.some((p) => p.level === "error") || !d.appDir) return 1;
  if (!d.hasEvolve) {
    err("✗ next-evolve isn't a dependency of this app: run `npx next-evolve init` first");
    return 1;
  }
  if (!d.hasZod) {
    err("✗ The generated schemas use Zod 4: add zod to your dependencies (`npm i zod`)");
    return 1;
  }
  const ts = loadTypescript(root);
  if (!ts) {
    err("✗ wrap reads your TypeScript props: typescript isn't installed");
    return 1;
  }
  const found = detectCandidates(ts, root, d.appDir, route);
  if ("error" in found) {
    err(`✗ ${found.error}`);
    return 1;
  }
  const list = found.candidates;
  for (const s of found.skipped) out(`  · skipped <${s.tag}> in ${s.page}: ${s.why}`);
  if (list.length === 0) {
    out(`Nothing to wrap${route ? ` on ${route}` : ""}: no component with editable props.`);
    return 0;
  }
  out(`Candidates (★ = recommended):\n${list.map(describe).join("\n")}`);

  // Pick.
  let picked: Candidate[];
  if (f.component) {
    const names = f.component
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    const unknown = names.filter(
      (n) =>
        !list.some((c) => c.name.toLowerCase() === n || c.tag.toLowerCase() === n || c.id === n),
    );
    if (unknown.length) {
      err(`✗ no candidate named ${unknown.join(", ")}`);
      return 1;
    }
    picked = list.filter(
      (c) =>
        names.includes(c.name.toLowerCase()) ||
        names.includes(c.tag.toLowerCase()) ||
        names.includes(c.id),
    );
  } else if (f.yes || !ask) {
    if (!f.yes && !dry) {
      err("✗ No terminal to pick in: pass --yes (recommended ones) or --component <Name>");
      return 1;
    }
    picked = list.filter((c) => c.recommended);
  } else {
    let p: Candidate[] | null = null;
    while (p === null) {
      p = parsePick(await ask("Wrap which? (e.g. 1,3 · all · Enter = ★): "), list);
      if (p === null) out("  Numbers from the list, comma-separated, or all.");
    }
    picked = p;
  }
  if (picked.length === 0) {
    out("Nothing picked; no changes.");
    return 0;
  }

  const plan = new Plan(root);
  const summary = planWrap(ts, plan, picked, { suspense: d.cacheComponents });
  const changes = plan.changes();
  out(`\n${renderDiff(changes)}`);
  if (dry) {
    out(`Dry run: ${changes.length} file(s) would change; nothing written.`);
    return 0;
  }
  if (!f.yes && ask) {
    const a = (await ask(`Write ${changes.length} file(s)? [y/N] `)).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      out("No changes written.");
      return 0;
    }
  }

  // Write all, check, restore everything on failure.
  const backup = changes.map((c) => {
    const p = join(root, c.path);
    return { p, bytes: existsSync(p) ? readFileSync(p) : null };
  });
  const restore = () => {
    for (const b of backup) {
      if (b.bytes === null) rmSync(b.p, { force: true });
      else writeFileSync(b.p, b.bytes);
    }
  };
  const onSignal = () => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  try {
    try {
      plan.apply();
    } catch (e) {
      restore();
      err(`✗ Writing failed (${e instanceof Error ? e.message : String(e)}); nothing changed.`);
      return 1;
    }
    const changed = changes.map((c) => c.path);
    const steps: VerifyStep[] = f.build ? ["tsc", "next build"] : ["tsc"];
    for (const step of steps) {
      out(`Checking: ${step}…`);
      const r = await verify(step, root, changed);
      if (!r.ok) {
        restore();
        err(r.output.trim().split("\n").slice(-40).join("\n"));
        err(`✗ ${step} failed after wrapping; every file is restored as it was.`);
        return 1;
      }
      if (r.output && step === "tsc" && /not caused by wrap/.test(r.output)) out(`! ${r.output}`);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
  }

  out(`✓ Wrapped ${summary.length} region(s):\n${summary.map((s) => `  ${s}`).join("\n")}`);
  const config = ["ts", "mjs", "js"]
    .map((e) => join(root, `evolve.config.${e}`))
    .find((p) => existsSync(p));
  const configText = config ? readFileSync(config, "utf8") : "";
  const missing = [...new Set(picked.map((c) => c.route))].filter(
    (r) => !configText.includes(JSON.stringify(r)),
  );
  if (missing.length)
    out(
      `! Add ${missing.join(", ")} to routes in evolve.config (or run \`npx next-evolve init --routes "${missing.join(" ")}"\`): regions only get variants on Evolve routes.`,
    );
  out(
    "Next: load the page once (the regions register on first render), then start an experiment in the dashboard.",
  );
  return 0;
}
