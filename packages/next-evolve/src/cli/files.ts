// The files `init` writes or edits (spec §16.1 steps 5, 6, 8–11). Each
// function is idempotent: when its change is already there it plans nothing.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { evolveMatcher, type MatcherEntry } from "../config/cdn";
import { defineConfig } from "../config/config";
import type { Detection } from "./detect";
import { evalMatcher, formatMatcher, matcherSource } from "./matcher";
import type { Plan } from "./plan";

export type RouteMode = { path: string; mode: "static" | "dynamic" };

const ext = (d: Detection) => (d.typescript ? "ts" : "js");
const base = (d: Detection) => (d.srcDir ? "src/" : "");

/** Import specifier from one project file to another (extension dropped). */
export function relImport(fromFile: string, toFile: string): string {
  const r = posix.relative(posix.dirname(fromFile), toFile).replace(/\.(tsx?|jsx?|mjs)$/, "");
  return r.startsWith("./") || r.startsWith("../") ? r : `./${r}`;
}

export const configFile = (d: Detection) => `evolve.config.${ext(d)}`;
export const goalsFile = (d: Detection) => `evolve.goals.${ext(d)}`;
export const routeFile = (d: Detection) => `${d.appDir}/api/evolve/[...evolve]/route.${ext(d)}`;
export const matcherFor = (routes: RouteMode[]) => [...routes.map((r) => r.path), "/(ev_.*)"];

/** `evolveMatcher()` for these routes, as `init` writes it into proxy.ts. */
export function matcherEntries(routes: RouteMode[], cdn: boolean): MatcherEntry[] {
  if (!cdn) return matcherFor(routes);
  return evolveMatcher(
    defineConfig({
      routes: Object.fromEntries(routes.map((r) => [r.path, { mode: r.mode }])),
      cdnRouting: true,
    }),
  );
}

const CDN_LINES = `  // Repeat views skip the proxy (served from the CDN by next.config's rewrites);
  // a pause or rollback reaches a returning visitor within one poll interval.
  cdnRouting: true,
`;

export function planConfig(plan: Plan, d: Detection, routes: RouteMode[], cdn = false): void {
  const routeLines = routes.map((r) => `    ${JSON.stringify(r.path)}: { mode: "${r.mode}" },`);
  const created = plan.create(
    configFile(d),
    `import { defineConfig } from "next-evolve/config";

export default defineConfig({
  // Pages Evolve may test. "static": cached per variant (moved under app/[evolve]/).
  // "dynamic": rendered per request, the page stays where it is.
  routes: {
${routeLines.join("\n")}
  },
${cdn ? CDN_LINES : ""}});
`,
  );
  if (!created && cdn) {
    const current = plan.read(configFile(d)) ?? "";
    if (!/\bcdnRouting\s*:/.test(current)) {
      const end = /\n\}\);\s*$/.exec(current);
      if (end) plan.write(configFile(d), `${current.slice(0, end.index)}\n${CDN_LINES}});\n`);
      else plan.manual.push(`Add cdnRouting: true to defineConfig({ … }) in ${configFile(d)}`);
    }
  }
  if (!created) {
    const current = plan.read(configFile(d)) ?? "";
    const missing = routes.filter((r) => !current.includes(JSON.stringify(r.path)));
    if (missing.length) {
      plan.manual.push(
        `Add to routes in ${configFile(d)}: ${missing.map((r) => `${JSON.stringify(r.path)}: { mode: "${r.mode}" }`).join(", ")}`,
      );
    }
  }
}

export function planGoals(plan: Plan, d: Detection): void {
  plan.create(
    goalsFile(d),
    `import { defineGoals } from "next-evolve/config";

// What counts as success. Fire events with data-evolve-goal="<event>" on a
// link or form, or evolve.track("<event>") on the server.
export default defineGoals({
  signed_up: { event: "signup", window: "7d" },
});
`,
  );
}

export function planRouteHandler(plan: Plan, d: Detection): void {
  const f = routeFile(d);
  plan.create(
    f,
    `import { createEvolveHandler } from "next-evolve/server";
import evolveConfig from "${relImport(f, configFile(d))}";
import goals from "${relImport(f, goalsFile(d))}";

// collect (beacon), track, sync (cloud webhook), aggregate (cloud), health
export const { GET, POST } = createEvolveHandler({ config: evolveConfig, goals });
export const maxDuration = 60;
`,
  );
}

export function planProxy(plan: Plan, d: Detection, routes: RouteMode[], cdn = false): void {
  const entries = matcherEntries(routes, cdn);
  const matcher = formatMatcher(entries, "  ");
  if (d.proxyFile) {
    const current = plan.read(d.proxyFile) ?? "";
    if (current.includes("next-evolve")) {
      if (cdn) upgradeMatcher(plan, d.proxyFile, current, routes, entries);
      return;
    }
    plan.manual.push(
      `Your ${d.proxyFile} exists, so add Evolve to it:
    import { applyEvolve } from "next-evolve/proxy";
    import buildBundle from "${relImport(d.proxyFile, ".evolve/bundle.generated.ts")}";
    import evolveConfig from "${relImport(d.proxyFile, configFile(d))}";
    // first thing in your ${d.proxyKind} function:
    const evolved = applyEvolve(evolveConfig, req, event, { buildBundle });
    if (evolved) return evolved;
  and ${cdn ? `set config.matcher to ${formatMatcher(entries, "    ")}` : `add ${matcher.slice(1, -1)} to config.matcher`}${d.proxyKind === "middleware" ? ', with runtime: "nodejs"' : ""}.`,
    );
    return;
  }
  const f = `${base(d)}${d.proxyKind}.${ext(d)}`;
  const imports = `import { createEvolveProxy } from "next-evolve/proxy";
import buildBundle from "${relImport(f, ".evolve/bundle.generated.ts")}";
import evolveConfig from "${relImport(f, configFile(d))}";
`;
  plan.write(
    f,
    d.proxyKind === "proxy"
      ? `${imports}
export const proxy = createEvolveProxy(evolveConfig, { buildBundle });
${configExport(entries, null)}`
      : `${imports}
export const middleware = createEvolveProxy(evolveConfig, { buildBundle });
${configExport(entries, "nodejs")}`,
  );
}

function configExport(entries: MatcherEntry[], runtime: string | null): string {
  const rt = runtime ? `, runtime: "${runtime}"` : "";
  if (entries.every((e) => typeof e === "string"))
    return `\nexport const config = { matcher: ${formatMatcher(entries)}${rt} };\n`;
  return `
// cdnRouting: evolveMatcher(evolveConfig), written out (Next needs a literal;
// \`npx next-evolve doctor\` checks it still matches evolve.config).
export const config = {
  matcher: ${formatMatcher(entries, "  ")},${runtime ? `\n  runtime: "${runtime}",` : ""}
};
`;
}

/**
 * cdnRouting on an app whose proxy.ts init wrote earlier: swap the plain
 * matcher for the cdnRouting one. Anything else gets instructions.
 */
function upgradeMatcher(
  plan: Plan,
  file: string,
  src: string,
  routes: RouteMode[],
  entries: MatcherEntry[],
): void {
  const text = matcherSource(src);
  const current = text ? evalMatcher(text) : null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (same(current, entries)) return;
  if (text && same(current, matcherFor(routes))) {
    plan.write(file, src.replace(text, formatMatcher(entries, "  ")));
    return;
  }
  plan.manual.push(
    `For cdnRouting, set config.matcher in ${file} to evolveMatcher(evolveConfig), written out:\n    ${formatMatcher(entries, "    ")}`,
  );
}

const REWRITES = `async rewrites() {
    return { beforeFiles: evolveRewrites(evolveConfig), afterFiles: [], fallback: [] };
  },`;

/**
 * cdnRouting: `next.config` serves a returning visitor's variant from the
 * route cookie (`evolveRewrites`). Creates next.config when there is none,
 * edits a plain one, and gives instructions for anything it can't edit safely
 * (own rewrites, CommonJS, a .mjs config next to a TypeScript evolve.config).
 */
export function planNextConfig(plan: Plan, d: Detection): void {
  const file = d.nextConfigFile ?? (d.typescript ? "next.config.ts" : "next.config.mjs");
  const cfgImport = relImport(file, configFile(d)) + (file.endsWith(".ts") ? "" : ".js");
  const imports = `import { evolveRewrites } from "next-evolve/config";\nimport evolveConfig from "${cfgImport}";`;
  const manual = (why: string): void => {
    plan.manual.push(
      `${why}. For cdnRouting, add to it:\n    ${imports.replace("\n", "\n    ")}\n    // in the config object (merge with your own beforeFiles rewrites, Evolve's first):\n    ${REWRITES.replace(/\n/g, "\n  ")}`,
    );
  };
  const src = plan.read(file);
  if (src === null) {
    plan.write(
      file,
      `${d.typescript ? 'import type { NextConfig } from "next";\n' : ""}${imports}

${d.typescript ? "const nextConfig: NextConfig = {" : "const nextConfig = {"}
  // Evolve cdnRouting: a returning visitor's variant is served from the CDN.
  ${REWRITES}
};

export default nextConfig;
`,
    );
    return;
  }
  if (src.includes("evolveRewrites")) return;
  const m = /(const\s+\w+\s*(?::\s*NextConfig\s*)?=\s*\{)|(export\s+default\s+(?:\(\s*)?\{)/.exec(
    src,
  );
  const why = /\brewrites\s*[(:]/.test(src)
    ? `${file} already has rewrites`
    : file.endsWith(".cjs") || /module\.exports/.test(src)
      ? `${file} is CommonJS`
      : d.typescript && !file.endsWith(".ts")
        ? `${file} can't import the TypeScript ${configFile(d)}`
        : !m
          ? `Couldn't find the config object in ${file}`
          : null;
  if (why || !m) {
    manual(why ?? file);
    return;
  }
  const at = m.index + m[0].length;
  const edited = `${src.slice(0, at)}\n  // Evolve cdnRouting: a returning visitor's variant is served from the CDN.\n  ${REWRITES}${src.slice(at)}`;
  plan.write(file, addImport(edited, imports));
}

/** Imports go after the last import line (or at the top). */
export function addImport(src: string, line: string): string {
  const lines = src.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (/^import\s/.test(l) || /^\s*} from ["']/.test(l)) last = i;
  });
  if (last === -1) {
    // Keep a leading "use client"/"use server" directive first.
    const directive = /^["']use (client|server)["'];?$/.test(lines[0] ?? "") ? 1 : 0;
    lines.splice(directive, 0, line, "");
  } else lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

export function planLayout(plan: Plan, d: Detection): void {
  const f = ["tsx", "jsx", "js", "ts"]
    .map((e) => `${d.appDir}/layout.${e}`)
    .find((p) => plan.exists(p));
  if (!f) {
    plan.manual.push(
      `Add <EvolveScript /> (from "next-evolve/client") to your root layout's <body>.`,
    );
    return;
  }
  const src = plan.read(f)!;
  if (src.includes("EvolveScript")) return;
  const m = /^([ \t]*)<\/body>/m.exec(src);
  let withTag: string;
  if (m) withTag = src.replace(m[0], `${m[1]}  <EvolveScript />\n${m[0]}`);
  else if (src.split("</body>").length === 2) {
    // `<body className="…">{children}</body>` on one line (create-next-app).
    withTag = src.replace("</body>", "<EvolveScript /></body>");
  } else {
    plan.manual.push(`Add <EvolveScript /> (from "next-evolve/client") inside <body> in ${f}.`);
    return;
  }
  plan.write(f, addImport(withTag, `import { EvolveScript } from "next-evolve/client";`));
}

export function planInstrumentation(plan: Plan, d: Detection): void {
  const f = `${base(d)}instrumentation.${ext(d)}`;
  const existing = ["ts", "js"]
    .map((e) => `${base(d)}instrumentation.${e}`)
    .find((p) => plan.exists(p));
  const block = `  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ registerEvolve }, { default: config }, { default: goals }] = await Promise.all([
      import("next-evolve/instrumentation"),
      import("${relImport(existing ?? f, configFile(d))}"),
      import("${relImport(existing ?? f, goalsFile(d))}"),
    ]);
    await registerEvolve({ config, goals });
  }`;
  if (!existing) {
    plan.write(f, `export async function register() {\n${block}\n}\n`);
    return;
  }
  const src = plan.read(existing)!;
  if (src.includes("registerEvolve")) return;
  const m = /export\s+(async\s+)?function\s+register\s*\([^)]*\)\s*(:\s*[^{]+)?\{\n?/.exec(src);
  if (!m) {
    plan.manual.push(`Add to register() in ${existing}:\n${block}`);
    return;
  }
  const head = m[1] ? m[0] : m[0].replace(/function/, "async function");
  plan.write(existing, src.replace(m[0], `${head.endsWith("\n") ? head : `${head}\n`}${block}\n`));
}

export function planPackageJson(plan: Plan): void {
  const src = plan.read("package.json");
  if (!src) return;
  const pkg = JSON.parse(src) as { scripts?: Record<string, string> };
  const pre = pkg.scripts?.prebuild;
  if (pre?.includes("next-evolve pull")) return;
  pkg.scripts = {
    ...pkg.scripts,
    prebuild: pre ? `next-evolve pull && ${pre}` : "next-evolve pull",
  };
  const indent = /^(\s+)"/m.exec(src)?.[1] ?? "  ";
  plan.write("package.json", `${JSON.stringify(pkg, null, indent)}\n`);
}

export function planGitignore(plan: Plan): void {
  const src = plan.read(".gitignore") ?? "";
  if (/^\/?\.evolve\/?$/m.test(src)) return;
  plan.write(
    ".gitignore",
    `${src}${src && !src.endsWith("\n") ? "\n" : ""}\n# Evolve build bundle\n.evolve/\n`,
  );
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const newTrackSecret = () =>
  `trk_${Array.from(randomBytes(32), (b) => BASE62[b % 62]).join("")}`;

/** Appends variables missing from .env.local; never changes a line that's there. */
export function planEnv(plan: Plan, vars: Record<string, string | undefined>): string[] {
  const src = plan.read(".env.local") ?? "";
  const has = (k: string) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=`, "m").test(src);
  const add = Object.entries(vars).filter(([k, v]) => v && !has(k));
  if (!add.length) return [];
  const lines = add.map(([k, v]) => `${k}=${v}`).join("\n");
  plan.write(
    ".env.local",
    `${src}${src && !src.endsWith("\n") ? "\n" : ""}${src ? "\n" : ""}# Evolve\n${lines}\n`,
  );
  return add.map(([k]) => k);
}
