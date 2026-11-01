// `init` step 7 (spec §16.1): static-mode pages move under app/[evolve]/ and
// get wrapped with withEvolve(). Parsing uses the app's own `typescript`
// (no extra dependency). When a move isn't safe the route stays dynamic and
// init says why.
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix } from "node:path";
import type * as TS from "typescript";
import type { Detection } from "./detect";
import { addImport, type RouteMode } from "./files";
import type { Plan } from "./plan";

const PAGE_EXTS = ["tsx", "jsx", "ts", "js"];
const SPECIAL = /^(layout|template|loading|error|not-found|default)\.(tsx|jsx|ts|js)$/;
const ROUTE_FILE = /^(page|route)\.(tsx|jsx|ts|js|mdx)$/;

/** The app's typescript, else the one next to next-evolve; null when neither exists. */
export function loadTypescript(root: string): typeof TS | null {
  for (const from of [join(root, "package.json"), import.meta.url]) {
    try {
      return createRequire(from)("typescript") as typeof TS;
    } catch {}
  }
  return null;
}

function list(root: string, dir: string): { files: string[]; dirs: string[] } {
  try {
    const entries = readdirSync(join(root, dir));
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      const full = join(root, dir, e);
      (statSync(full).isDirectory() ? dirs : files).push(e);
    }
    return { files, dirs };
  } catch {
    return { files: [], dirs: [] };
  }
}

/** Whether any folder below `dir` holds a page or route handler. */
function hasChildRoutes(root: string, dir: string): boolean {
  for (const sub of list(root, dir).dirs) {
    const p = `${dir}/${sub}`;
    if (list(root, p).files.some((f) => ROUTE_FILE.test(f)) || hasChildRoutes(root, p)) return true;
  }
  return false;
}

/** Finds `seg/page.*` inside some route group, for the note. */
function findInGroup(root: string, dir: string, seg: string): string | null {
  for (const sub of list(root, dir).dirs) {
    if (!/^\(.+\)$/.test(sub)) continue;
    const p = `${dir}/${sub}`;
    const page = PAGE_EXTS.map((e) => `${p}/${seg ? `${seg}/` : ""}page.${e}`).find((f) =>
      list(root, posix.dirname(f)).files.includes(posix.basename(f)),
    );
    if (page) return sub;
    const deeper = findInGroup(root, p, seg);
    if (deeper) return deeper;
  }
  return null;
}

export function planPages(plan: Plan, d: Detection, routes: RouteMode[]): RouteMode[] {
  const app = d.appDir;
  if (!app || !routes.some((r) => r.mode === "static")) return routes;
  const dynamicRoot = list(plan.root, app).dirs.find((x) => /^\[.+\]$/.test(x) && x !== "[evolve]");
  const ts = loadTypescript(plan.root);

  return routes.map((r) => {
    if (r.mode !== "static") return r;
    const keep = (why: string): RouteMode => {
      plan.notes.push(`${r.path}: kept dynamic, ${why}`);
      return { ...r, mode: "dynamic" };
    };
    if (dynamicRoot) {
      return keep(
        `${app}/${dynamicRoot} conflicts with ${app}/[evolve] (static mode needs the top-level dynamic segment); "dynamic" mode works`,
      );
    }
    const seg = r.path.replace(/^\/|\/$/g, "");
    const from = seg ? `${app}/${seg}` : app;
    const to = seg ? `${app}/[evolve]/${seg}` : `${app}/[evolve]`;
    const pageName = PAGE_EXTS.map((e) => `page.${e}`).find((f) => plan.exists(`${from}/${f}`));
    const moved = PAGE_EXTS.map((e) => `${to}/page.${e}`).find((f) => plan.exists(f));
    if (!pageName) {
      if (moved && plan.read(moved)!.includes("withEvolve")) return r; // already done
      const group = findInGroup(plan.root, app, seg);
      return keep(
        group
          ? `the page is inside the route group ${group}; move it under ${app}/[evolve]/ by hand for static mode`
          : `no page found at ${from}/page.*`,
      );
    }
    if (moved) return keep(`${moved} already exists`);
    if (!ts) return keep(`typescript isn't installed, so the page can't be moved safely`);

    const src = plan.read(`${from}/${pageName}`)!;
    const rewritten = wrapPage(ts, src, pageName, r.path);
    if (!rewritten.ok) return keep(rewritten.why);

    // What moves with the page: co-located files, unless child routes would lose them.
    const files = list(plan.root, from).files;
    let movers = [pageName];
    if (seg) {
      if (hasChildRoutes(plan.root, from)) {
        const special = files.find((f) => SPECIAL.test(f));
        if (special) return keep(`${from}/${special} also wraps its child routes`);
      } else movers = files;
    }
    const map = new Map(movers.map((f) => [`${from}/${f}`, `${to}/${f}`]));
    for (const [oldPath, newPath] of map) {
      const content = oldPath.endsWith(`/${pageName}`) ? rewritten.code : plan.read(oldPath)!;
      const code = /\.(tsx?|jsx?|mjs|cjs)$/.test(oldPath)
        ? rewriteImports(ts, content, oldPath, newPath, map)
        : content;
      plan.write(newPath, code);
      plan.remove(oldPath);
    }
    plan.notes.push(`${r.path}: moved ${from}/${pageName} → ${to}/${pageName} (static mode)`);
    return r;
  });
}

type Edit = { start: number; end: number; text: string };
const applyEdits = (src: string, edits: Edit[]) =>
  [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), src);

const kindFor = (ts: typeof TS, file: string) =>
  file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".ts")
      ? ts.ScriptKind.TS
      : file.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
const parse = (ts: typeof TS, src: string, file: string) =>
  ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kindFor(ts, file));

const hasMod = (ts: typeof TS, n: TS.Node, k: TS.SyntaxKind) =>
  (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some((m) => m.kind === k) ?? false;

/** Removes `export` (and `default`) modifiers from a declaration. */
function stripExport(ts: typeof TS, n: TS.Node, sf: TS.SourceFile): Edit[] {
  const mods = (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined) ?? [];
  return mods
    .filter(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword,
    )
    .map((m) => {
      let end = m.getEnd();
      while (/\s/.test(sf.text[end] ?? "")) end++;
      return { start: m.getStart(sf), end, text: "" };
    });
}

function exportedConst(ts: typeof TS, s: TS.Statement, name: string) {
  if (!ts.isVariableStatement(s) || !hasMod(ts, s, ts.SyntaxKind.ExportKeyword)) return null;
  return (
    s.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name) ??
    null
  );
}

/** Wraps the page module: default export → withEvolve, metadata → evolveMetadata. */
export function wrapPage(
  ts: typeof TS,
  src: string,
  file: string,
  path: string,
): { ok: true; code: string } | { ok: false; why: string } {
  const sf = parse(ts, src, file);
  const first = sf.statements[0];
  if (
    first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use client"
  )
    return { ok: false, why: `the page is "use client" (withEvolve needs a server page)` };

  const edits: Edit[] = [];
  let component: string | null = null;
  let metadata: string | null = null;
  const has = { revalidate: false, dynamicParams: false };

  for (const s of sf.statements) {
    const dyn = exportedConst(ts, s, "dynamic");
    if (
      dyn?.initializer &&
      ts.isStringLiteral(dyn.initializer) &&
      dyn.initializer.text === "force-dynamic"
    )
      return { ok: false, why: `the page sets dynamic = "force-dynamic"` };
    const dp = exportedConst(ts, s, "dynamicParams");
    if (dp) {
      if (dp.initializer?.kind === ts.SyntaxKind.FalseKeyword)
        return { ok: false, why: "the page sets dynamicParams = false" };
      has.dynamicParams = true;
    }
    if (exportedConst(ts, s, "revalidate")) has.revalidate = true;
    if (exportedConst(ts, s, "generateStaticParams"))
      return { ok: false, why: "the page has its own generateStaticParams" };
    if (
      ts.isFunctionDeclaration(s) &&
      hasMod(ts, s, ts.SyntaxKind.ExportKeyword) &&
      !hasMod(ts, s, ts.SyntaxKind.DefaultKeyword)
    ) {
      if (s.name?.text === "generateStaticParams")
        return { ok: false, why: "the page has its own generateStaticParams" };
      if (s.name?.text === "generateMetadata") {
        edits.push(...stripExport(ts, s, sf));
        edits.push({ start: s.name.getStart(sf), end: s.name.getEnd(), text: "baseMetadata" });
        metadata = "baseMetadata";
      }
    }
    if (exportedConst(ts, s, "generateMetadata") && ts.isVariableStatement(s)) {
      const decl = exportedConst(ts, s, "generateMetadata")!;
      edits.push(...stripExport(ts, s, sf));
      edits.push({ start: decl.name.getStart(sf), end: decl.name.getEnd(), text: "baseMetadata" });
      metadata = "baseMetadata";
    }
    if (exportedConst(ts, s, "metadata") && ts.isVariableStatement(s)) {
      edits.push(...stripExport(ts, s, sf));
      metadata = "metadata";
    }

    // Default export
    if (
      (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) &&
      hasMod(ts, s, ts.SyntaxKind.DefaultKeyword)
    ) {
      edits.push(...stripExport(ts, s, sf));
      if (s.name) component = s.name.text;
      else {
        component = "Page";
        const kw = s
          .getChildren(sf)
          .find(
            (c) =>
              c.kind === ts.SyntaxKind.FunctionKeyword || c.kind === ts.SyntaxKind.ClassKeyword,
          )!;
        const star = ts.isFunctionDeclaration(s) ? s.asteriskToken : undefined;
        const at = star ? star.getEnd() : kw.getEnd();
        let end = at;
        while (/\s/.test(sf.text[end] ?? "")) end++;
        edits.push({ start: at, end, text: " Page" });
      }
    } else if (ts.isExportAssignment(s) && !s.isExportEquals) {
      if (ts.isIdentifier(s.expression)) {
        component = s.expression.text;
        let end = s.getEnd();
        if (sf.text[end] === "\n") end++;
        edits.push({ start: s.getStart(sf), end, text: "" });
      } else {
        component = "Page";
        edits.push({
          start: s.getStart(sf),
          end: s.expression.getStart(sf),
          text: "const Page = ",
        });
      }
    } else if (ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause)) {
      if (s.exportClause.elements.some((e) => e.name.text === "default"))
        return { ok: false, why: "the default export is re-exported by name; wrap it by hand" };
    }
  }
  if (!component) return { ok: false, why: "the page has no default export" };

  // Missing next-evolve names, merged into an existing import when there is one.
  const want = ["evolveMetadata", "evolveStaticParams", "withEvolve"];
  const existing = sf.statements.find(
    (s): s is TS.ImportDeclaration =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "next-evolve" &&
      !s.importClause?.isTypeOnly &&
      !!s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings),
  );
  let addLine: string | null = null;
  if (existing) {
    const named = existing.importClause!.namedBindings as TS.NamedImports;
    const have = named.elements.map((e) => e.name.text);
    const add = want.filter((n) => !have.includes(n));
    if (add.length) {
      const last = named.elements[named.elements.length - 1];
      const at = last ? last.getEnd() : named.getStart(sf) + 1;
      edits.push({ start: at, end: at, text: `${last ? ", " : " "}${add.join(", ")}` });
    }
  } else addLine = `import { ${want.join(", ")} } from "next-evolve";`;

  let code = applyEdits(src, edits);
  if (addLine) code = addImport(code, addLine);
  const p = JSON.stringify(path);
  const tail = [
    "",
    "// Static mode (next-evolve): one cached render per variant under [evolve].",
    ...(has.dynamicParams ? [] : ["export const dynamicParams = true;"]),
    "export const generateStaticParams = evolveStaticParams;",
    ...(has.revalidate ? [] : ["export const revalidate = 3600;"]),
    `export const generateMetadata = evolveMetadata(${p}${metadata ? `, ${metadata}` : ""});`,
    `export default withEvolve(${component}, { path: ${p} });`,
    "",
  ];
  return { ok: true, code: `${code.replace(/\s*$/, "\n")}${tail.join("\n")}` };
}

/** Rewrites relative specifiers for a file that moved; files moving together keep pointing at each other. */
export function rewriteImports(
  ts: typeof TS,
  src: string,
  oldPath: string,
  newPath: string,
  moves: Map<string, string>,
): string {
  const sf = parse(ts, src, oldPath);
  const edits: Edit[] = [];
  const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
  const movedNoExt = new Map([...moves].map(([o, n]) => [stripExt(o), stripExt(n)]));
  const fix = (lit: TS.StringLiteralLike) => {
    const spec = lit.text;
    if (!spec.startsWith("./") && !spec.startsWith("../")) return;
    let target = posix.normalize(posix.join(posix.dirname(oldPath), spec));
    target = moves.get(target) ?? movedNoExt.get(target) ?? target;
    let rel = posix.relative(posix.dirname(newPath), target);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (rel !== spec) edits.push({ start: lit.getStart(sf) + 1, end: lit.getEnd() - 1, text: rel });
  };
  const visit = (n: TS.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    )
      fix(n.moduleSpecifier);
    else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === "require")) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    )
      fix(n.arguments[0]);
    else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteral(n.argument.literal)
    )
      fix(n.argument.literal);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return applyEdits(src, edits);
}
