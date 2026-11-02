// The files `init` writes or edits (spec §16.1 steps 5, 6, 8–11). Each
// function is idempotent: when its change is already there it plans nothing.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Detection } from "./detect";
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
const list = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

export function planConfig(plan: Plan, d: Detection, routes: RouteMode[]): void {
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
});
`,
  );
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

export function planProxy(plan: Plan, d: Detection, routes: RouteMode[]): void {
  const matcher = list(matcherFor(routes));
  if (d.proxyFile) {
    const current = plan.read(d.proxyFile) ?? "";
    if (current.includes("next-evolve")) return;
    plan.manual.push(
      `Your ${d.proxyFile} exists, so add Evolve to it:
    import { applyEvolve } from "next-evolve/proxy";
    import buildBundle from "${relImport(d.proxyFile, ".evolve/bundle.generated.ts")}";
    import evolveConfig from "${relImport(d.proxyFile, configFile(d))}";
    // first thing in your ${d.proxyKind} function:
    const evolved = applyEvolve(evolveConfig, req, event, { buildBundle });
    if (evolved) return evolved;
  and add ${matcher.slice(1, -1)} to config.matcher${d.proxyKind === "middleware" ? ', with runtime: "nodejs"' : ""}.`,
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

export const config = { matcher: ${matcher} };
`
      : `${imports}
export const middleware = createEvolveProxy(evolveConfig, { buildBundle });

export const config = { matcher: ${matcher}, runtime: "nodejs" };
`,
  );
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
