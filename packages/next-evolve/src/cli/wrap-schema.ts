// `wrap` (SDK-5): a component's TypeScript props → the Zod schema of the
// props Evolve may change. Rules (PRD §7 SDK-5): string → z.string().max(n),
// literal union → z.enum, number, boolean, optional, arrays of those. Anything
// else (objects, functions, nodes, null, enums) isn't editable and stays a
// plain prop. Uses the app's own `typescript` (no extra dependency).
import type * as TS from "typescript";

/** An editable prop's shape. */
export type ZodShape =
  | { k: "string" }
  | { k: "number" }
  | { k: "boolean" }
  | { k: "enum"; values: string[] }
  | { k: "numbers"; values: number[] }
  | { k: "array"; of: Exclude<ZodShape, { k: "array" }> };

export type PropInfo =
  | { name: string; optional: boolean; shape: ZodShape }
  | { name: string; optional: boolean; shape: null; why: string };

/** Props that look like links, assets, styling or identifiers: kept as-is even when they're strings. */
const URL_LIKE = /(^|[a-z])(href|url|src|link|image|img|avatar|icon|logo|video)s?$/i;
const FIXED = new Set(["className", "style", "id", "key", "ref", "as", "testId", "slot"]);

const inPackage = (sf: TS.SourceFile) => /[\\/]node_modules[\\/]/.test(sf.fileName);

function fixedReason(name: string): string | null {
  if (FIXED.has(name)) return "styling or an identifier";
  if (/^(aria|data)-/.test(name)) return "an HTML attribute";
  if (/^on[A-Z]/.test(name)) return "an event handler";
  return null;
}

/** String props named like a link or asset (href, imageUrl, logos…) stay fixed. */
const urlLike = (name: string, shape: ZodShape) =>
  (shape.k === "string" || (shape.k === "array" && shape.of.k === "string")) &&
  URL_LIKE.test(name) &&
  !/(label|text|alt|title)/i.test(name);

/** Classifies one type; `null` with a reason when it isn't editable. */
function classify(
  ts: typeof TS,
  checker: TS.TypeChecker,
  t: TS.Type,
): { shape: ZodShape } | { shape: null; why: string } {
  const F = ts.TypeFlags;
  if (/\b(ReactNode|ReactElement|JSX\.Element)\b/.test(checker.typeToString(t)))
    return { shape: null, why: "React content" };
  const members = t.isUnion() ? t.types : [t];
  if (members.some((m) => m.flags & F.Null)) return { shape: null, why: "nullable" };
  const rest = members.filter((m) => !(m.flags & (F.Undefined | F.Void)));
  if (rest.length === 0) return { shape: null, why: "always undefined" };
  if (rest.some((m) => m.flags & F.EnumLike)) return { shape: null, why: "a TypeScript enum" };

  if (rest.every((m) => m.flags & F.BooleanLiteral))
    return rest.length === 2 ? { shape: { k: "boolean" } } : { shape: null, why: "a fixed value" };
  if (rest.every((m) => m.isStringLiteral())) {
    const values = rest.map((m) => (m as TS.StringLiteralType).value);
    return values.length > 1
      ? { shape: { k: "enum", values } }
      : { shape: null, why: "a fixed value" };
  }
  if (rest.every((m) => m.isNumberLiteral())) {
    const values = rest.map((m) => (m as TS.NumberLiteralType).value);
    return values.length > 1
      ? { shape: { k: "numbers", values } }
      : { shape: null, why: "a fixed value" };
  }
  if (rest.length > 1) return { shape: null, why: "a mixed union" };

  const one = rest[0]!;
  if (one.flags & F.String) return { shape: { k: "string" } };
  if (one.flags & F.Number) return { shape: { k: "number" } };
  if (one.flags & F.Boolean) return { shape: { k: "boolean" } };
  if (checker.isArrayType(one)) {
    const el = checker.getTypeArguments(one as TS.TypeReference)[0];
    if (!el) return { shape: null, why: "an array" };
    const inner = classify(ts, checker, el);
    const elOptional = el.isUnion() && el.types.some((m) => m.flags & F.Undefined);
    if (inner.shape && inner.shape.k !== "array" && !elOptional)
      return { shape: { k: "array", of: inner.shape } };
    return { shape: null, why: "an array of objects" };
  }
  if (one.getCallSignatures().length) return { shape: null, why: "a function" };
  if (one.flags & F.TemplateLiteral) return { shape: null, why: "a template literal type" };
  return { shape: null, why: "an object" };
}

/** The props of a component's props type, in declaration order. Props React/DOM declare (from packages) are left out. */
export function propsOf(
  ts: typeof TS,
  checker: TS.TypeChecker,
  propsType: TS.Type,
  at: TS.Node,
): PropInfo[] {
  const out: PropInfo[] = [];
  for (const sym of checker.getPropertiesOfType(propsType)) {
    const decls = sym.declarations ?? [];
    const name = sym.getName();
    const own = decls.some((d) => !inPackage(d.getSourceFile()));
    if (!own) continue;
    const t = checker.getTypeOfSymbolAtLocation(sym, at);
    const optional =
      Boolean(sym.flags & ts.SymbolFlags.Optional) ||
      (t.isUnion() && t.types.some((m) => m.flags & ts.TypeFlags.Undefined));
    const fixed = fixedReason(name);
    if (fixed) {
      out.push({ name, optional, shape: null, why: fixed });
      continue;
    }
    const c = classify(ts, checker, t);
    if (!c.shape) out.push({ name, optional, shape: null, why: c.why });
    else if (urlLike(name, c.shape))
      out.push({ name, optional, shape: null, why: "a link or asset URL" });
    else out.push({ name, optional, shape: c.shape });
  }
  return out;
}

/** Default max length for a string prop, from its name (a button label is short, a quote isn't). */
export function stringMaxFor(name: string): number {
  const n = name.toLowerCase();
  if (/(sub(title|heading|headline)|tagline|caption|summary|message|teaser)/.test(n)) return 160;
  if (/(cta|button|label|action|badge|tag|eyebrow|kicker|placeholder|price|currency)/.test(n))
    return 40;
  if (/(title|headline|heading|name|author|role|position|company|plan)/.test(n)) return 80;
  if (/(description|body|text|copy|quote|content|answer|paragraph|bio|details|blurb)/.test(n))
    return 400;
  return 120;
}

/** The max for a string prop: the name heuristic, raised so the longest value the page passes fits with room. */
export function stringMax(name: string, longest = 0): number {
  const base = stringMaxFor(name);
  return longest > base ? Math.ceil((longest * 1.5) / 10) * 10 : base;
}

function render(shape: ZodShape, name: string, longest: number): string {
  switch (shape.k) {
    case "string":
      return `z.string().max(${stringMax(name, longest)})`;
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "enum":
      return `z.enum([${shape.values.map((v) => JSON.stringify(v)).join(", ")}])`;
    case "numbers":
      return `z.literal([${shape.values.join(", ")}])`;
    case "array":
      return `z.array(${render(shape.of, name, longest)})`;
  }
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const keyOf = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));

/**
 * `z.object({ … })` source for the editable props. `longest` maps a prop to
 * the longest string the pages pass for it (so the control values fit).
 */
export function schemaSource(props: PropInfo[], longest: Map<string, number> = new Map()): string {
  const lines = props
    .filter((p) => p.shape)
    .map(
      (p) =>
        `  ${keyOf(p.name)}: ${render(p.shape!, p.name, longest.get(p.name) ?? 0)}${p.optional ? ".optional()" : ""},`,
    );
  return `z.object({\n${lines.join("\n")}\n})`;
}

/** "Not editable" comment line for the props wrap left out, or null. */
export function fixedComment(props: PropInfo[]): string | null {
  const fixed = props.filter((p): p is Extract<PropInfo, { shape: null }> => !p.shape);
  if (fixed.length === 0) return null;
  return `// Kept as you pass them (not editable): ${fixed.map((p) => `${p.name} (${p.why})`).join(", ")}.`;
}
