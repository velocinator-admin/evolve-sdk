// `wrap` (SDK-5) candidate detection: the components a route's page renders,
// with their props classified (wrap-schema) and ranked by how much they look
// like something worth testing (hero, pricing, CTA…). Uses the app's own
// `typescript` and tsconfig, so path aliases and barrels resolve.
import { readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { REGION_ID_RE } from "@next-evolve/protocol";
import type * as TS from "typescript";
import { type PropInfo, propsOf } from "./wrap-schema";

export type PageFile = { file: string; route: string };

export type Candidate = {
  /** Page file, relative to the project root (posix). */
  page: string;
  route: string;
  /** The JSX tag as written in the page (`Hero`, `UI.Hero`). */
  tag: string;
  /** The component's name (declared name, else the tag). */
  name: string;
  /** Where it's declared; `exportName` null = a local component of the page file. */
  source: { file: string; exportName: string | null };
  props: PropInfo[];
  editable: number;
  score: number;
  /** Selected by default (`--yes`, Enter in the picker). */
  recommended: boolean;
  id: string;
  /** For the rewrite: the element in the page's source file. */
  element: TS.JsxElement | TS.JsxSelfClosingElement;
  /** The import that brings the tag into the page (null for local components). */
  importDecl: TS.ImportDeclaration | null;
  /** The top-level statement declaring a local component (null when imported). */
  localStatement: TS.Statement | null;
  /** Longest string literal the page passes per prop (for max lengths). */
  longest: Map<string, number>;
};

export type Skipped = { page: string; tag: string; why: string };

export type Detection = {
  pages: PageFile[];
  candidates: Candidate[];
  skipped: Skipped[];
  program: TS.Program;
  checker: TS.TypeChecker;
};

const PAGE = /^page\.(tsx|ts|jsx|js)$/;

/** Route path of a page file under the app dir: groups, slots and [evolve] dropped. */
export function routeOf(appDir: string, file: string): string {
  const segs = posix
    .dirname(posix.relative(appDir, file))
    .split("/")
    .filter((s) => s && s !== "." && !/^\(.+\)$/.test(s) && !s.startsWith("@") && s !== "[evolve]");
  return `/${segs.join("/")}`;
}

/** Every page.* under the app dir (private `_folders` and `api` skipped). */
export function findPages(root: string, appDir: string): PageFile[] {
  const out: PageFile[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      const p = `${dir}/${e}`;
      if (statSync(join(root, p)).isDirectory()) {
        if (!e.startsWith("_") && e !== "node_modules" && !(dir === appDir && e === "api")) walk(p);
      } else if (PAGE.test(e)) out.push({ file: p, route: routeOf(appDir, p) });
    }
  };
  walk(appDir);
  return out;
}

export const normalizeRoute = (r: string) => `/${r.trim().replace(/^\/+|\/+$/g, "")}`;

const NAME_HINT =
  /hero|pricing|price|plan|cta|calltoaction|banner|headline|testimonial|faq|feature|signup|newsletter|offer|promo|announcement|highlight|countdown|valueprop|intro|benefit/i;
const NAME_NEGATIVE =
  /footer|nav|header$|layout|container|wrapper|provider|icon|logo$|divider|spacer|skeleton/i;
const PROP_HEADING = /^(title|headline|heading|name)$|title$|headline$|heading$/i;
const PROP_ACTION = /cta|button|label|action|submit/i;

function scoreOf(
  name: string,
  props: PropInfo[],
  declText: string,
): { score: number; editable: number } {
  const editable = props.filter((p) => p.shape).map((p) => p.name);
  let score = 0;
  if (NAME_HINT.test(name.replace(/[-_]/g, ""))) score += 3;
  if (NAME_NEGATIVE.test(name)) score -= 2;
  if (editable.some((p) => PROP_HEADING.test(p))) score += 2;
  if (editable.some((p) => PROP_ACTION.test(p))) score += 2;
  if (/<h[1-3][\s>]/.test(declText)) score += 1;
  if (/<(a|button|Link)[\s>]/.test(declText)) score += 1;
  score += Math.min(editable.length, 4) * 0.5;
  return { score, editable: editable.length };
}

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Region id: `<route>-<component>`, valid per REGION_ID_RE and unique among `taken`. */
export function regionId(route: string, name: string, taken: Set<string>): string {
  const r = kebab(route.replace(/[[\]]/g, "")) || "home";
  const c = kebab(name) || "region";
  // "/pricing" + PricingTable → "pricing-table", not "pricing-pricing-table".
  let base = (c === r || c.startsWith(`${r}-`) ? c : `${r}-${c}`).slice(0, 40).replace(/-+$/, "");
  if (!/^[a-z0-9]/.test(base)) base = `r${base}`.slice(0, 40);
  let id = base;
  for (let n = 2; taken.has(id) || !REGION_ID_RE.test(id); n++) {
    const suffix = `-${n}`;
    id = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
  }
  taken.add(id);
  return id;
}

/** The app's tsconfig, parsed; null when there is none. */
export function loadTsconfig(ts: typeof TS, root: string): TS.ParsedCommandLine | null {
  const path = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!path || resolve(path, "..") !== resolve(root)) return null;
  const parsed = ts.getParsedCommandLineOfConfigFile(path, { noEmit: true }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => {},
  } as TS.ParseConfigFileHost);
  return parsed ?? null;
}

const isFunctionLike = (ts: typeof TS, n: TS.Node) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);

/** The page component: the default export, or the component passed to withEvolve(). */
function pageComponent(ts: typeof TS, sf: TS.SourceFile): TS.Node | null {
  const local = (name: string): TS.Node | null => {
    for (const s of sf.statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
      if (ts.isVariableStatement(s))
        for (const d of s.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer)
            return fnOf(d.initializer);
    }
    return null;
  };
  const fnOf = (e: TS.Expression): TS.Node | null => {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isIdentifier(e)) return local(e.text);
    if (ts.isCallExpression(e) && e.arguments[0]) return fnOf(e.arguments[0]); // withEvolve(Home, …)
    if (ts.isParenthesizedExpression(e)) return fnOf(e.expression);
    return null;
  };
  for (const s of sf.statements) {
    const mods = ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined;
    const isDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(s) && isDefault) return s;
    if (ts.isExportAssignment(s) && !s.isExportEquals) return fnOf(s.expression);
  }
  return null;
}

function isUseClient(ts: typeof TS, sf: TS.SourceFile): boolean {
  const first = sf.statements[0];
  return Boolean(
    first &&
      ts.isExpressionStatement(first) &&
      ts.isStringLiteral(first.expression) &&
      first.expression.text === "use client",
  );
}

/** The import declaration and top-level statement a symbol comes from in `sf`. */
function importOf(ts: typeof TS, sym: TS.Symbol): TS.ImportDeclaration | null {
  for (const d of sym.declarations ?? []) {
    let n: TS.Node | undefined = d;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    if (n) return n as TS.ImportDeclaration;
  }
  return null;
}

/** Ids of `<Optimizable id="…">` elements already in these files. */
function existingIds(ts: typeof TS, files: readonly TS.SourceFile[]): Set<string> {
  const ids = new Set<string>();
  const visit = (n: TS.Node) => {
    if (
      (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
      n.tagName.getText() === "Optimizable"
    ) {
      for (const a of n.attributes.properties)
        if (
          ts.isJsxAttribute(a) &&
          a.name.getText() === "id" &&
          a.initializer &&
          ts.isStringLiteral(a.initializer)
        )
          ids.add(a.initializer.text);
    }
    ts.forEachChild(n, visit);
  };
  for (const f of files) visit(f);
  return ids;
}

/** Longest string literal passed per attribute (for string max lengths). */
function literalLengths(
  ts: typeof TS,
  attrs: TS.JsxAttributes,
  children: string | null,
): Map<string, number> {
  const m = new Map<string, number>();
  const strings = (e: TS.Node): number => {
    if (ts.isStringLiteralLike(e)) return e.text.length;
    let max = 0;
    ts.forEachChild(e, (c) => {
      max = Math.max(max, strings(c));
    });
    return max;
  };
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a) || !a.initializer) continue;
    m.set(a.name.getText(), strings(a.initializer));
  }
  if (children) m.set("children", children.length);
  return m;
}

/**
 * Finds the wrap candidates on the given pages (all pages when `route` is
 * omitted). Region ids are unique across every page of the app.
 */
export function detectCandidates(
  ts: typeof TS,
  root: string,
  appDir: string,
  route?: string,
): Detection | { error: string } {
  const config = loadTsconfig(ts, root);
  if (!config)
    return { error: "wrap reads your TypeScript props: this project has no tsconfig.json" };
  const allPages = findPages(root, appDir);
  const pages = route ? allPages.filter((p) => p.route === normalizeRoute(route)) : allPages;
  if (route && pages.length === 0)
    return {
      error: `no page for ${normalizeRoute(route)} under ${appDir}/ (pages: ${allPages.map((p) => p.route).join(", ") || "none"})`,
    };
  const program = ts.createProgram({
    rootNames: allPages.map((p) => join(root, p.file)),
    options: { ...config.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const userFiles = program
    .getSourceFiles()
    .filter((f) => !f.isDeclarationFile && !/[\\/]node_modules[\\/]/.test(f.fileName));
  const taken = existingIds(ts, userFiles);
  const rel = (abs: string) => relative(root, abs).split(sep).join("/");

  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  for (const page of pages) {
    const sf = program.getSourceFile(join(root, page.file));
    if (!sf) continue;
    if (isUseClient(ts, sf)) {
      skipped.push({ page: page.file, tag: "(page)", why: `the page is "use client"` });
      continue;
    }
    const pageFn = pageComponent(ts, sf);
    if (!pageFn) {
      skipped.push({ page: page.file, tag: "(page)", why: "no default-exported page component" });
      continue;
    }
    const elements: (TS.JsxElement | TS.JsxSelfClosingElement)[] = [];
    const visit = (n: TS.Node) => {
      if (ts.isJsxSelfClosingElement(n)) elements.push(n);
      else if (ts.isJsxElement(n)) elements.push(n);
      ts.forEachChild(n, visit);
    };
    visit(pageFn);

    for (const el of elements) {
      const opening = ts.isJsxElement(el) ? el.openingElement : el;
      const tag = opening.tagName.getText(sf);
      if (/^[a-z]/.test(tag) || tag.includes("-") || tag === "Optimizable") continue;
      const skip = (why: string) => skipped.push({ page: page.file, tag, why });

      let fn: TS.Node | undefined = el.parent;
      while (fn && !isFunctionLike(ts, fn)) fn = fn.parent;
      if (fn !== pageFn) {
        skip("rendered inside a callback (e.g. .map()), so it isn't one region");
        continue;
      }
      const tagNode = ts.isPropertyAccessExpression(opening.tagName)
        ? opening.tagName.name
        : opening.tagName;
      let sym = checker.getSymbolAtLocation(tagNode);
      if (!sym) continue;
      const alias = sym;
      if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) continue;
      const declSf = decl.getSourceFile();
      if (declSf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(declSf.fileName)) continue;
      if (
        opening.attributes.properties.some(
          (a) => ts.isJsxAttribute(a) && a.name.getText() === "ref",
        )
      ) {
        skip("passes a ref");
        continue;
      }

      const compType = checker.getTypeOfSymbolAtLocation(sym, tagNode);
      if (/OptimizableComponent|Optimizable\(/.test(checker.typeToString(compType))) {
        skip("already optimizable(): wrap the usage in <Optimizable> by hand");
        continue;
      }
      const sig = compType.getCallSignatures()[0];
      if (!sig) {
        skip("not a function component");
        continue;
      }
      if (sig.typeParameters?.length) {
        skip("a generic component");
        continue;
      }
      const param = sig.getParameters()[0];
      if (!param) {
        skip("takes no props");
        continue;
      }
      const propsType = checker.getTypeOfSymbolAtLocation(param, tagNode);
      if (propsType.isUnion()) {
        skip("its props are a union type");
        continue;
      }
      const props = propsOf(ts, checker, propsType, tagNode);
      const local = declSf === sf;
      let exportName: string | null = null;
      let localStatement: TS.Statement | null = null;
      if (local) {
        let st: TS.Node = decl;
        while (st.parent && st.parent !== sf) st = st.parent;
        localStatement = st as TS.Statement;
      } else {
        const declPath = rel(declSf.fileName);
        if (
          pages.some((p) => p.file === declPath) ||
          /(^|\/)(layout|template)\.\w+$/.test(declPath)
        ) {
          skip("declared in a route file");
          continue;
        }
        const mod = checker.getSymbolAtLocation(declSf);
        const exp = mod
          ? checker
              .getExportsOfModule(mod)
              .find(
                (e) =>
                  e === sym ||
                  (e.flags & ts.SymbolFlags.Alias && checker.getAliasedSymbol(e) === sym),
              )
          : undefined;
        if (!exp) {
          skip(`not exported from ${declPath}`);
          continue;
        }
        exportName = exp.getName();
      }
      const declName =
        (ts.isFunctionDeclaration(decl) || ts.isVariableDeclaration(decl)) &&
        decl.name &&
        ts.isIdentifier(decl.name)
          ? decl.name.text
          : null;
      const name = declName && /^[A-Z]/.test(declName) ? declName : tag.split(".").pop()!;
      const { score, editable } = scoreOf(name, props, decl.getText(declSf));
      if (editable === 0) {
        skip("no props Evolve can edit (strings, numbers, booleans, literal unions)");
        continue;
      }
      const childText =
        ts.isJsxElement(el) && el.children.every((c) => ts.isJsxText(c))
          ? el.children
              .map((c) => c.getText(sf))
              .join("")
              .trim()
          : null;
      candidates.push({
        page: page.file,
        route: page.route,
        tag,
        name,
        source: { file: rel(declSf.fileName), exportName },
        props,
        editable,
        score,
        recommended: score >= 3,
        id: "",
        element: el,
        importDecl: local ? null : importOf(ts, alias),
        localStatement,
        longest: literalLengths(ts, opening.attributes, childText),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.page.localeCompare(b.page));
  for (const c of [...candidates].sort(
    (a, b) => a.page.localeCompare(b.page) || a.element.pos - b.element.pos,
  ))
    c.id = regionId(c.route, c.name, taken);
  return { pages, candidates, skipped, program, checker };
}
