// `wrap` (SDK-5) rewrite: for each picked candidate, an `optimizable()`
// export with the generated schema and an `<Optimizable id>` usage on the
// page. Imported components get a sibling `<file>.evolve.ts` (server-only,
// so the component file itself is untouched and stays importable from client
// components); a page's local components get the schema in the page.
import { posix } from "node:path";
import type * as TS from "typescript";
import { addImport, relImport } from "./files";
import type { Plan } from "./plan";
import type { Candidate } from "./wrap-detect";
import { fixedComment, schemaSource } from "./wrap-schema";

type Edit = { start: number; end: number; text: string };
const applyEdits = (src: string, edits: Edit[]) =>
  [...edits]
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), src);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** `foo/hero.tsx` → `foo/hero.evolve.ts`. */
export const siblingOf = (file: string) => `${file.replace(/\.(tsx?|jsx?)$/, "")}.evolve.ts`;

/** Column of the line a node starts on (its indentation). */
function indentOf(sf: TS.SourceFile, n: TS.Node): number {
  const start = n.getStart(sf);
  const lineStart = sf.text.lastIndexOf("\n", start - 1) + 1;
  return /^[ \t]*/.exec(sf.text.slice(lineStart, start))![0].length;
}

/** JSX text → the string React renders (lines trimmed and joined); null when it has entities. */
function jsxText(raw: string): string | null {
  if (/[&{}<>]/.test(raw)) return null;
  if (!raw.includes("\n")) return raw;
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

/** The props object entries of a JSX element, from its attributes and children. */
function propEntries(
  ts: typeof TS,
  sf: TS.SourceFile,
  el: TS.JsxElement | TS.JsxSelfClosingElement,
): { entries: string[]; key: string | null } {
  const opening = ts.isJsxElement(el) ? el.openingElement : el;
  const entries: string[] = [];
  /** Re-indents a multi-line value from its attribute's column to an entry's (props object, 2 deeper). */
  const shift = (text: string, node: TS.Node) => {
    if (!text.includes("\n")) return text;
    const start = node.getStart(sf);
    const col = start - (sf.text.lastIndexOf("\n", start - 1) + 1);
    const delta = 4 - (col - indentOf(sf, el));
    return text
      .split("\n")
      .map((l, i) =>
        i === 0
          ? l
          : delta >= 0
            ? " ".repeat(delta) + l
            : l.replace(new RegExp(`^ {0,${-delta}}`), ""),
      )
      .join("\n");
  };
  let key: string | null = null;
  for (const a of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      entries.push(`...${a.expression.getText(sf)}`);
      continue;
    }
    const name = a.name.getText(sf);
    const k = IDENT.test(name) ? name : JSON.stringify(name);
    const init = a.initializer;
    let value: string | null;
    if (!init) value = "true";
    else if (ts.isStringLiteral(init)) value = JSON.stringify(init.text);
    else if (ts.isJsxExpression(init)) value = init.expression ? init.expression.getText(sf) : null;
    else value = init.getText(sf);
    if (value === null) continue;
    if (name === "key") {
      key = init && ts.isStringLiteral(init) ? init.getText(sf) : `{${value}}`;
      continue;
    }
    entries.push(value === name && IDENT.test(name) ? name : shift(`${k}: ${value}`, a));
  }
  if (ts.isJsxElement(el)) {
    const kids = el.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
    if (kids.length) {
      let value: string | null = null;
      if (kids.every((c) => ts.isJsxText(c))) {
        const t = jsxText(kids.map((c) => c.getText(sf)).join(""));
        if (t !== null) value = JSON.stringify(t);
      } else if (kids.length === 1 && ts.isJsxExpression(kids[0]!) && kids[0].expression)
        value = kids[0].expression.getText(sf);
      if (value === null) {
        const inner = sf.text.slice(el.openingElement.getEnd(), el.closingElement.getStart(sf));
        value = shift(`<>${inner}</>`, kids[0]!);
      }
      entries.push(`children: ${value}`);
    }
  }
  return { entries, key };
}

/** `<Optimizable id component props />`, on one line when it fits in 100 columns. */
export function optimizableJsx(
  id: string,
  component: string,
  entries: string[],
  key: string | null,
  indent: string,
): string {
  const obj = entries.length ? `{ ${entries.join(", ")} }` : "{}";
  const attrs = [
    ...(key ? [`key=${key}`] : []),
    `id=${JSON.stringify(id)}`,
    `component={${component}}`,
    `props={${obj}}`,
  ];
  const one = `<Optimizable ${attrs.join(" ")} />`;
  if (indent.length + one.length <= 100 && !one.includes("\n")) return one;
  const inner = `${indent}  `;
  const propsAttr =
    inner.length + `props={${obj}}`.length <= 100 && !obj.includes("\n")
      ? `props={${obj}}`
      : `props={{\n${entries.map((e) => `${inner}  ${e},`).join("\n")}\n${inner}}}`;
  return `<Optimizable\n${[...attrs.slice(0, -1), propsAttr].map((a) => `${inner}${a}`).join("\n")}\n${indent}/>`;
}

/** Adds names to an existing `import { … } from "<mod>"`, else an import line. */
function ensureNamedImport(
  ts: typeof TS,
  sf: TS.SourceFile,
  mod: string,
  names: string[],
  edits: Edit[],
  lines: string[],
): void {
  const existing = sf.statements.find(
    (s): s is TS.ImportDeclaration =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === mod &&
      !s.importClause?.isTypeOnly &&
      !!s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings),
  );
  if (existing) {
    const named = existing.importClause!.namedBindings as TS.NamedImports;
    const have = named.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text);
    const add = names.filter((n) => !have.includes(n));
    if (!add.length) return;
    const last = named.elements[named.elements.length - 1];
    const at = last ? last.getEnd() : named.getStart(sf) + 1;
    edits.push({ start: at, end: at, text: `${last ? ", " : " "}${add.join(", ")}` });
  } else lines.push(`import { ${names.join(", ")} } from ${JSON.stringify(mod)};`);
}

/** Removes names from an import declaration (the whole statement when none are left). */
function removeImportNames(
  ts: typeof TS,
  sf: TS.SourceFile,
  decl: TS.ImportDeclaration,
  names: Set<string>,
): Edit[] {
  const clause = decl.importClause;
  if (!clause || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) return [];
  const def = clause.name && !names.has(clause.name.text) ? clause.name.text : null;
  const named =
    clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      ? clause.namedBindings.elements
          .filter((e) => !names.has(e.name.text))
          .map((e) => e.getText(sf))
      : [];
  const start = decl.getStart(sf);
  let end = decl.getEnd();
  if (!def && named.length === 0) {
    if (sf.text[end] === "\n") end++;
    return [{ start, end, text: "" }];
  }
  const parts = [...(def ? [def] : []), ...(named.length ? [`{ ${named.join(", ")} }`] : [])];
  const semi = sf.text[end - 1] === ";" ? ";" : "";
  return [
    {
      start,
      end,
      text: `import ${parts.join(", ")} from ${decl.moduleSpecifier.getText(sf)}${semi}`,
    },
  ];
}

/** Whether `name` is still referenced in `sf` outside the given ranges and imports. */
function stillUsed(ts: typeof TS, sf: TS.SourceFile, name: string, removed: Edit[]): boolean {
  let used = false;
  const visit = (n: TS.Node) => {
    if (used) return;
    if (ts.isImportDeclaration(n)) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isJsxAttribute(p) && p.name === n);
      const at = n.getStart(sf);
      if (!isPropName && !removed.some((r) => at >= r.start && at < r.end)) used = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return used;
}

function uniqueName(want: string, taken: Set<string>): string {
  let n = want;
  for (let i = 2; taken.has(n); i++) n = `${want}${i}`;
  taken.add(n);
  return n;
}

function identifiersOf(ts: typeof TS, sf: TS.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: TS.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const HEADER = (
  file: string,
) => `// Evolve regions for ./${posix.basename(file)}, generated by \`npx next-evolve wrap\`.
// A schema lists the props Evolve may change: tighten limits, add .meta({ label: "…" })
// or .meta({ locked: true }), or delete a line to keep a prop fixed. Server-only.
`;

/** Merges the longest string per prop across a component's usages. */
function longestOf(cs: Candidate[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cs) for (const [k, v] of c.longest) m.set(k, Math.max(m.get(k) ?? 0, v));
  return m;
}

/**
 * Plans the edits for the picked candidates: sibling `.evolve.ts` files and
 * page rewrites. Returns one line per region for the summary.
 */
export function planWrap(
  ts: typeof TS,
  plan: Plan,
  picked: Candidate[],
  opts: { suspense?: boolean } = {},
): string[] {
  const summary: string[] = [];
  const key = (c: Candidate) => `${c.source.file}#${c.source.exportName ?? c.name}`;
  const groups = new Map<string, Candidate[]>();
  for (const c of picked) groups.set(key(c), [...(groups.get(key(c)) ?? []), c]);

  // 1. Sibling files: one per component source file, one export per component.
  const exportOf = new Map<string, string>(); // group key → exported name
  const bySibling = new Map<string, Candidate[][]>();
  for (const cs of groups.values()) {
    if (cs[0]!.source.exportName === null) continue;
    const sib = siblingOf(cs[0]!.source.file);
    bySibling.set(sib, [...(bySibling.get(sib) ?? []), cs]);
  }
  for (const [sib, comps] of bySibling) {
    const current = plan.read(sib);
    const taken = new Set(["optimizable", "z"]);
    if (current)
      for (const m of current.matchAll(/\b(?:const|function|import)\s+(\w+)/g)) taken.add(m[1]!);
    let head =
      current ??
      `${HEADER(comps[0]![0]!.source.file)}import { optimizable } from "next-evolve";\nimport { z } from "zod";\n`;
    if (current && !/\boptimizable\b.*from "next-evolve"/.test(current))
      head = addImport(head, `import { optimizable } from "next-evolve";`);
    if (current && !/import \{ z \} from "zod"/.test(current))
      head = addImport(head, `import { z } from "zod";`);
    const blocks: string[] = [];
    const compImports = new Map<string, { def: string | null; named: string[] }>();
    for (const cs of comps) {
      const c = cs[0]!;
      const already = current?.match(
        new RegExp(`export const (Optimizable${c.name}\\d*) = optimizable\\(`),
      );
      if (already) {
        exportOf.set(key(c), already[1]!);
        continue;
      }
      const spec = relImport(sib, c.source.file);
      const isDefault = c.source.exportName === "default";
      const local = uniqueName(isDefault ? c.name : c.source.exportName!, taken);
      const imp = compImports.get(spec) ?? { def: null, named: [] };
      if (isDefault) imp.def = local;
      else
        imp.named.push(
          `${c.source.exportName}${local === c.source.exportName ? "" : ` as ${local}`}`,
        );
      compImports.set(spec, imp);
      const schema = uniqueName(`${lowerFirst(c.name)}Schema`, taken);
      const exported = uniqueName(`Optimizable${c.name}`, taken);
      exportOf.set(key(c), exported);
      const fixed = fixedComment(c.props);
      blocks.push(
        `export const ${schema} = ${schemaSource(c.props, longestOf(cs))};\n${fixed ? `${fixed}\n` : ""}\nexport const ${exported} = optimizable(${local}, ${schema});\n`,
      );
    }
    for (const [spec, imp] of compImports) {
      const parts = [
        ...(imp.def ? [imp.def] : []),
        ...(imp.named.length ? [`{ ${imp.named.join(", ")} }`] : []),
      ];
      head = addImport(head, `import ${parts.join(", ")} from ${JSON.stringify(spec)};`);
    }
    if (blocks.length) plan.write(sib, `${head.replace(/\s*$/, "\n")}\n${blocks.join("\n")}`);
  }

  // 2. Pages.
  const byPage = new Map<string, Candidate[]>();
  for (const c of picked) byPage.set(c.page, [...(byPage.get(c.page) ?? []), c]);
  for (const [page, cs] of byPage) {
    const sf = cs[0]!.element.getSourceFile();
    const src = sf.text;
    const edits: Edit[] = [];
    const importLines: string[] = [];
    const taken = identifiersOf(ts, sf);
    const replaced: Edit[] = [];
    const localNames = new Map<string, string>(); // group key → name used in the page

    // Local components: schema + optimizable() right after their declaration.
    const locals = new Map<TS.Statement, Candidate[]>();
    for (const c of cs)
      if (c.localStatement)
        locals.set(c.localStatement, [...(locals.get(c.localStatement) ?? []), c]);
    for (const [st, lcs] of locals) {
      const c = lcs[0]!;
      const schema = uniqueName(`${lowerFirst(c.name)}Schema`, taken);
      const wrapped = uniqueName(`Optimizable${c.name}`, taken);
      localNames.set(key(c), wrapped);
      const fixed = fixedComment(c.props);
      edits.push({
        start: st.getEnd(),
        end: st.getEnd(),
        text: `\n\nconst ${schema} = ${schemaSource(c.props, longestOf(groups.get(key(c))!))};\n${fixed ? `${fixed}\n` : ""}const ${wrapped} = optimizable(${c.name}, ${schema});`,
      });
    }
    // Imported components: import the sibling's export.
    const siblingImports = new Map<string, string[]>();
    for (const c of cs) {
      if (c.localStatement || localNames.has(key(c))) continue;
      const exported = exportOf.get(key(c))!;
      const name = uniqueName(exported, taken);
      localNames.set(key(c), name);
      const sib = siblingOf(c.source.file);
      const orig =
        c.importDecl && ts.isStringLiteral(c.importDecl.moduleSpecifier)
          ? c.importDecl.moduleSpecifier.text
          : null;
      const sameFile =
        orig !== null &&
        posix.basename(orig).replace(/\.(tsx?|jsx?)$/, "") ===
          posix.basename(c.source.file).replace(/\.(tsx?|jsx?)$/, "");
      const spec = sameFile
        ? `${orig!.replace(/\.(tsx?|jsx?)$/, "")}.evolve`
        : relImport(page, sib);
      const binding = name === exported ? exported : `${exported} as ${name}`;
      siblingImports.set(spec, [...(siblingImports.get(spec) ?? []), binding]);
    }
    // Usages.
    for (const c of cs) {
      const el = c.element;
      const start = el.getStart(sf);
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const indent = /^\s*/.exec(src.slice(lineStart, start))![0];
      const { entries, key: k } = propEntries(ts, sf, el);
      // cacheComponents: <Optimizable> reads request data, so it needs a <Suspense> boundary.
      const text = opts.suspense
        ? `<Suspense${k ? ` key=${k}` : ""}>\n${indent}  ${optimizableJsx(c.id, localNames.get(key(c))!, entries, null, `${indent}  `)}\n${indent}</Suspense>`
        : optimizableJsx(c.id, localNames.get(key(c))!, entries, k, indent);
      const e = { start, end: el.getEnd(), text };
      edits.push(e);
      replaced.push(e);
      summary.push(`${c.id}: <${c.tag}> on ${c.route} (${page})`);
    }
    // Drop imports of components that are no longer used directly.
    const unused = new Map<TS.ImportDeclaration, Set<string>>();
    for (const c of cs) {
      if (!c.importDecl || c.tag.includes(".")) continue; // namespace import: keep
      if (stillUsed(ts, sf, c.tag, replaced)) continue;
      unused.set(c.importDecl, (unused.get(c.importDecl) ?? new Set()).add(c.tag));
    }
    for (const [decl, names] of unused) edits.push(...removeImportNames(ts, sf, decl, names));
    ensureNamedImport(
      ts,
      sf,
      "next-evolve",
      locals.size ? ["Optimizable", "optimizable"] : ["Optimizable"],
      edits,
      importLines,
    );
    if (locals.size) ensureNamedImport(ts, sf, "zod", ["z"], edits, importLines);
    if (opts.suspense) ensureNamedImport(ts, sf, "react", ["Suspense"], edits, importLines);
    for (const [spec, names] of siblingImports)
      importLines.push(
        `import { ${[...new Set(names)].join(", ")} } from ${JSON.stringify(spec)};`,
      );

    let code = applyEdits(src, edits);
    for (const l of importLines) code = addImport(code, l);
    // Removed and added imports can leave a double blank line after the import block.
    code = code.replace(/^((?:import [^\n]*\n)+)\n{2,}/m, "$1\n");
    plan.write(page, code);
  }
  return summary;
}
