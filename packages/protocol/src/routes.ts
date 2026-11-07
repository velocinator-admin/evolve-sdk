// Route keys (D77, TPL-1.1): `routing.routes` keys and `evolve.config.ts`
// routes are exact paths or Next-style patterns:
//   /lp/:slug            one segment
//   /docs/:path*         zero or more trailing segments (last segment only)
//   /docs/:path+         one or more trailing segments (last segment only)
//   /:name([A-Z][a-z]+)  one segment that matches a regex constraint (1.4.0)
//
// Shared by next-evolve (request matching) and the cloud (validation, wizard
// samples), so both accept exactly the same keys. A constraint is matched
// against the whole raw segment (anchored) by a Thompson-NFA simulation, so
// request-path matching is linear in the path length whatever the constraint.
// The validator also rejects the constructs that make a backtracking engine
// (Next's own `matcher`) slow: backreferences, lookarounds and nested
// quantifiers. Pure module: no Node imports (the dashboard bundles it).

/** Longest regex constraint on one param, in characters. */
export const MAX_CONSTRAINT_LENGTH = 200;
/** Compiled program size cap (counted repeats expand), so a constraint stays cheap. */
const MAX_PROGRAM = 2000;

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PARAM_RE = new RegExp(`^:(${NAME})([*+])?$`);
const CONSTRAINED_RE = new RegExp(`^:(${NAME})\\((.*)\\)([*+?])?$`);
const LITERAL_RE = /^[^:[\]*?#()]+$/;

export type RouteSegment =
  | { kind: "literal"; text: string }
  | { kind: "param"; name: string; rest?: "*" | "+"; constraint?: string };

/** Whether a route key is a pattern (has a `:param` segment). */
export const isRoutePattern = (key: string): boolean => key.includes("/:");

/**
 * Splits a pattern key into segments, or explains why it isn't one (the
 * messages read well after the key: `/lp/:p*\/x: …`).
 */
export function parseRouteKey(key: string): RouteSegment[] | string {
  if (!key.startsWith("/")) return "must start with /";
  let depth = 0;
  for (const ch of key) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "/" && depth > 0) return "a constraint can't contain /";
  }
  const segs = key.split("/").slice(1);
  const out: RouteSegment[] = [];
  const names = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const p = PARAM_RE.exec(s);
    const c = p ? null : CONSTRAINED_RE.exec(s);
    if (!p && !c) {
      if (!LITERAL_RE.test(s)) return `segment "${s}" must be a literal or :param`;
      out.push({ kind: "literal", text: s });
      continue;
    }
    const name = (p ?? c)![1]!;
    if (names.has(name)) return `:${name} appears twice`;
    names.add(name);
    if (p) {
      const rest = p[2] as "*" | "+" | undefined;
      if (rest && i !== segs.length - 1) return `:${name}${rest} must be the last segment`;
      out.push(rest ? { kind: "param", name, rest } : { kind: "param", name });
      continue;
    }
    if (c![3]) return `:${name}(…)${c![3]}: a constrained param matches exactly one segment`;
    const err = constraintError(c![2]!);
    if (err) return `:${name}(${c![2]}): ${err}`;
    out.push({ kind: "param", name, constraint: c![2]! });
  }
  if (!out.some((s) => s.kind === "param")) return "not a pattern";
  return out;
}

/** Param names of a route key, in order (`/:name/:city` → name, city). [] for an exact path. */
export function routeParamNames(key: string): string[] {
  if (!isRoutePattern(key)) return [];
  const segs = parseRouteKey(key);
  if (typeof segs === "string") return [];
  return segs.flatMap((s) => (s.kind === "param" ? [s.name] : []));
}

/** Whether any param of a (valid) pattern key has a regex constraint. */
export function hasConstraint(key: string): boolean {
  const segs = isRoutePattern(key) ? parseRouteKey(key) : [];
  return typeof segs !== "string" && segs.some((s) => s.kind === "param" && !!s.constraint);
}

export type RouteParams = Record<string, string | string[]>;

export type CompiledRoute = {
  key: string;
  segments: RouteSegment[];
  /** Params (catch-alls as arrays), raw (still percent-encoded), or null when the path doesn't match. */
  match(path: string): RouteParams | null;
  /** Number of params. */
  params: number;
  /** Characters before the first param (more = more specific). */
  prefix: number;
  /** Ends in a catch-all (`*` / `+`). */
  rest: boolean;
  /** Has at least one regex constraint (served before unconstrained patterns). */
  constrained: boolean;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compiles a pattern key once: a native regex for the segment structure (only
 * literals and `[^/]+`, so linear) plus one linear-time matcher per constraint.
 */
export function compileRoute(key: string): CompiledRoute | string {
  const segments = parseRouteKey(key);
  if (typeof segments === "string") return segments;
  let re = "^";
  let prefix = -1;
  let params = 0;
  let rest = false;
  const tests: (((s: string) => boolean) | null)[] = [];
  const names: string[] = [];
  const isRest: boolean[] = [];
  let len = 0;
  for (const s of segments) {
    if (s.kind === "literal") {
      re += `/${escapeRe(s.text)}`;
      len += s.text.length + 1;
      continue;
    }
    if (prefix < 0) prefix = len;
    params++;
    names.push(s.name);
    isRest.push(Boolean(s.rest));
    if (s.rest) {
      rest = true;
      re += s.rest === "*" ? "((?:/[^/]+)*)" : "((?:/[^/]+)+)";
      tests.push(null);
    } else {
      re += "/([^/]+)";
      tests.push(s.constraint ? compileConstraint(s.constraint) : null);
    }
  }
  const structure = new RegExp(`${re}$`);
  return {
    key,
    segments,
    params,
    prefix,
    rest,
    constrained: tests.some(Boolean),
    match(path: string) {
      const m = structure.exec(path);
      if (!m) return null;
      const out: RouteParams = {};
      for (let i = 0; i < names.length; i++) {
        const v = m[i + 1] ?? "";
        const t = tests[i];
        if (t && !t(v)) return null;
        out[names[i]!] = isRest[i] ? v.split("/").filter(Boolean) : v;
      }
      return out;
    },
  };
}

/**
 * Serving order (TPL-1.1): constrained patterns before unconstrained, then
 * D77's specificity (fewest params, longest static prefix, no catch-all), then key.
 */
export function compareRoutes(a: CompiledRoute, b: CompiledRoute): number {
  return (
    Number(b.constrained) - Number(a.constrained) ||
    a.params - b.params ||
    b.prefix - a.prefix ||
    Number(a.rest) - Number(b.rest) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/**
 * Why `key` isn't a valid route key (an exact path or a pattern), or null.
 * Exact paths carry no pattern syntax.
 */
export function routeKeyError(key: string): string | null {
  if (!key.startsWith("/")) return "must start with /";
  if (!isRoutePattern(key))
    return /[[\]*?#:()]/.test(key) ? "must be a path or a pattern like /lp/:slug" : null;
  const segs = parseRouteKey(key);
  return typeof segs === "string" ? segs : null;
}

// ---------------------------------------------------------------------------
// Constraint regexes: a safe subset of JavaScript regex syntax.
//   literals, `.`, \d \w \s (and \D \W \S outside []), escaped punctuation,
//   [classes] with ranges, (?:groups), alternation |, quantifiers * + ? {n} {n,} {n,m}
// Refused: capturing groups (Next's matcher refuses them too), backreferences,
// lookarounds, anchors (constraints are anchored already), nested quantifiers,
// and quantified groups with alternation (ambiguous repetition).

type CharSet = { ranges: number[]; neg: boolean };
type Node =
  | { t: "set"; set: CharSet }
  | { t: "cat"; items: Node[] }
  | { t: "alt"; alts: Node[] }
  | { t: "rep"; node: Node; min: number; max: number };

const DIGIT = [48, 57];
const WORD = [48, 57, 65, 90, 95, 95, 97, 122];
const SPACE = [
  9, 13, 32, 32, 160, 160, 5760, 5760, 8192, 8202, 8232, 8233, 8239, 8239, 8287, 8287, 12288, 12288,
  65279, 65279,
];
const ANY: CharSet = { ranges: [], neg: true };
const ESCAPABLE = new Set("^$\\.*+?()[]{}|/-");
const MAX_REPEAT = 100;

class ConstraintSyntaxError extends Error {}

function parseConstraint(src: string): Node {
  let i = 0;
  const fail = (m: string): never => {
    throw new ConstraintSyntaxError(m);
  };
  const peek = () => src[i];

  function alternation(): Node {
    const alts = [sequence()];
    while (peek() === "|") {
      i++;
      alts.push(sequence());
    }
    return alts.length === 1 ? alts[0]! : { t: "alt", alts };
  }

  function sequence(): Node {
    const items: Node[] = [];
    while (i < src.length && peek() !== "|" && peek() !== ")") {
      const atom = atomNode();
      items.push(quantified(atom));
    }
    return { t: "cat", items };
  }

  function quantified(atom: Node): Node {
    let q: { min: number; max: number } | null = null;
    const c = peek();
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    else if (c === "{") {
      const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(src.slice(i));
      if (!m) fail("write a literal { as \\{");
      const min = Number(m![1]);
      const max = m![2] === undefined ? min : m![3] === "" ? Infinity : Number(m![3]);
      if (max < min) fail(`{${min},${max}}: the maximum is below the minimum`);
      if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT))
        fail(`repeat counts go up to ${MAX_REPEAT}`);
      q = { min, max };
      i += m![0].length - 1;
    }
    if (!q) return atom;
    i++;
    if (peek() === "?") i++; // lazy: same set of matches
    const n = peek();
    if (n === "*" || n === "+" || n === "?" || n === "{") fail("nested quantifiers aren't allowed");
    if (containsRep(atom))
      fail("nested quantifiers aren't allowed (a quantified group with a quantifier inside)");
    if (containsAlt(atom)) fail("a quantified group can't contain | (ambiguous repetition)");
    return { t: "rep", node: atom, min: q.min, max: q.max };
  }

  function atomNode(): Node {
    const c = src[i]!;
    if (c === "(") {
      if (src.startsWith("(?:", i)) {
        i += 3;
        const inner = alternation();
        if (peek() !== ")") fail("unclosed (");
        i++;
        return inner;
      }
      if (/^\(\?<?[=!]/.test(src.slice(i))) fail("lookarounds aren't allowed");
      fail("capturing groups aren't allowed; use (?:…)");
    }
    if (c === ")") fail("unmatched )");
    if (c === "[") return { t: "set", set: charClass() };
    if (c === "]") fail("unmatched ] (write \\])");
    if (c === "}") fail("write a literal } as \\}");
    if (c === "^" || c === "$") fail("constraints are anchored already; drop ^ and $");
    if (c === "*" || c === "+" || c === "?" || c === "{") fail(`nothing to repeat before ${c}`);
    if (c === ".") {
      i++;
      return { t: "set", set: ANY };
    }
    if (c === "\\") return { t: "set", set: readEscape(false) };
    i++;
    const code = c.charCodeAt(0);
    return { t: "set", set: { ranges: [code, code], neg: false } };
  }

  /** After `\`: a class escape or an escaped punctuation character. */
  function readEscape(inClass: boolean): CharSet {
    i++;
    const e = src[i];
    if (e === undefined) fail("trailing \\");
    i++;
    if (e === "d") return { ranges: DIGIT, neg: false };
    if (e === "w") return { ranges: WORD, neg: false };
    if (e === "s") return { ranges: SPACE, neg: false };
    if (e === "D" || e === "W" || e === "S") {
      if (inClass) fail(`\\${e} isn't supported inside [ ]`);
      return { ranges: e === "D" ? DIGIT : e === "W" ? WORD : SPACE, neg: true };
    }
    if (/[1-9]/.test(e!) || e === "k") fail("backreferences aren't allowed");
    if (e === "b" || e === "B") fail("word boundaries aren't allowed");
    if (ESCAPABLE.has(e!)) {
      const code = e!.charCodeAt(0);
      return { ranges: [code, code], neg: false };
    }
    return fail(`\\${e} isn't supported`);
  }

  function charClass(): CharSet {
    i++; // [
    const neg = peek() === "^";
    if (neg) i++;
    const ranges: number[] = [];
    let first = true;
    while (true) {
      const c = src[i];
      if (c === undefined) fail("unclosed [");
      if (c === "]" && !first) break;
      if (c === "]") fail("empty [ ]");
      first = false;
      let lo: number;
      if (c === "\\") {
        const s = readEscape(true);
        if (s.ranges.length > 2 || s.ranges[0] !== s.ranges[1]) {
          ranges.push(...s.ranges);
          continue;
        }
        lo = s.ranges[0]!;
      } else {
        if (c === "[") fail("write a literal [ inside [ ] as \\[");
        lo = c!.charCodeAt(0);
        i++;
      }
      if (peek() === "-" && src[i + 1] !== "]" && src[i + 1] !== undefined) {
        i++;
        let hi: number;
        if (peek() === "\\") {
          const s = readEscape(true);
          if (s.ranges.length > 2 || s.ranges[0] !== s.ranges[1]) fail("bad range in [ ]");
          hi = s.ranges[0]!;
        } else {
          hi = src.charCodeAt(i);
          i++;
        }
        if (hi < lo) fail("range out of order in [ ]");
        ranges.push(lo, hi);
      } else ranges.push(lo, lo);
    }
    i++; // ]
    return { ranges, neg };
  }

  const node = alternation();
  if (i < src.length) fail(peek() === ")" ? "unmatched )" : `unexpected ${peek()}`);
  return node;
}

function containsRep(n: Node): boolean {
  if (n.t === "rep") return true;
  if (n.t === "cat") return n.items.some(containsRep);
  if (n.t === "alt") return n.alts.some(containsRep);
  return false;
}

function containsAlt(n: Node): boolean {
  if (n.t === "alt") return true;
  if (n.t === "cat") return n.items.some(containsAlt);
  if (n.t === "rep") return containsAlt(n.node);
  return false;
}

/**
 * Why a regex constraint isn't accepted, or null. ≤ 200 characters, the safe
 * subset above, and it must not match the empty string.
 */
export function constraintError(src: string): string | null {
  if (src.length === 0) return "empty constraint";
  if (src.length > MAX_CONSTRAINT_LENGTH)
    return `constraints are at most ${MAX_CONSTRAINT_LENGTH} characters`;
  if (src.includes("/")) return "a constraint can't contain /";
  try {
    const prog = compileProgram(parseConstraint(src));
    if (run(prog, "")) return "the constraint matches an empty segment";
    return null;
  } catch (e) {
    if (e instanceof ConstraintSyntaxError) return e.message;
    throw e;
  }
}

// --- Thompson NFA (Pike VM without captures): O(path length × program size).

const CHAR = 0;
const SPLIT = 1;
const JMP = 2;
const MATCH = 3;
type Inst = { op: number; set?: CharSet; x?: number; y?: number };

function compileProgram(node: Node): Inst[] {
  const prog: Inst[] = [];
  const emit = (inst: Inst) => {
    if (prog.length >= MAX_PROGRAM)
      throw new ConstraintSyntaxError("the constraint is too complex");
    prog.push(inst);
    return prog.length - 1;
  };
  function gen(n: Node): void {
    switch (n.t) {
      case "set":
        emit({ op: CHAR, set: n.set });
        return;
      case "cat":
        for (const it of n.items) gen(it);
        return;
      case "alt": {
        const jumps: number[] = [];
        for (let k = 0; k < n.alts.length - 1; k++) {
          const split = emit({ op: SPLIT });
          prog[split]!.x = prog.length;
          gen(n.alts[k]!);
          jumps.push(emit({ op: JMP }));
          prog[split]!.y = prog.length;
        }
        gen(n.alts[n.alts.length - 1]!);
        for (const j of jumps) prog[j]!.x = prog.length;
        return;
      }
      case "rep": {
        for (let k = 0; k < n.min; k++) gen(n.node);
        if (n.max === Infinity) {
          const split = emit({ op: SPLIT });
          prog[split]!.x = prog.length;
          gen(n.node);
          emit({ op: JMP, x: split });
          prog[split]!.y = prog.length;
          return;
        }
        const splits: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          const split = emit({ op: SPLIT });
          prog[split]!.x = prog.length;
          splits.push(split);
          gen(n.node);
        }
        for (const s of splits) prog[s]!.y = prog.length;
        return;
      }
    }
  }
  gen(node);
  emit({ op: MATCH });
  return prog;
}

function inSet(set: CharSet, c: number): boolean {
  const r = set.ranges;
  let hit = false;
  for (let k = 0; k < r.length; k += 2) {
    if (c >= r[k]! && c <= r[k + 1]!) {
      hit = true;
      break;
    }
  }
  return hit !== set.neg;
}

function run(prog: Inst[], s: string): boolean {
  const n = prog.length;
  const mark = new Int32Array(n).fill(-1);
  let clist = new Int32Array(n);
  let nlist = new Int32Array(n);
  let ccount = 0;
  let ncount = 0;
  const stack = new Int32Array(n * 2 + 2);
  const add = (list: Int32Array, count: number, pc0: number, gen: number): number => {
    let sp = 0;
    stack[sp++] = pc0;
    while (sp > 0) {
      const pc = stack[--sp]!;
      if (mark[pc] === gen) continue;
      mark[pc] = gen;
      const inst = prog[pc]!;
      if (inst.op === JMP) stack[sp++] = inst.x!;
      else if (inst.op === SPLIT) {
        stack[sp++] = inst.y!;
        stack[sp++] = inst.x!;
      } else list[count++] = pc;
    }
    return count;
  };
  ccount = add(clist, 0, 0, 0);
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    ncount = 0;
    for (let t = 0; t < ccount; t++) {
      const inst = prog[clist[t]!]!;
      if (inst.op === CHAR && inSet(inst.set!, c))
        ncount = add(nlist, ncount, clist[t]! + 1, k + 1);
    }
    if (ncount === 0) return false;
    [clist, nlist] = [nlist, clist];
    ccount = ncount;
  }
  for (let t = 0; t < ccount; t++) if (prog[clist[t]!]!.op === MATCH) return true;
  return false;
}

/**
 * Compiles a constraint to an anchored, linear-time test over a whole segment.
 * Throws on a constraint {@link constraintError} refuses.
 */
export function compileConstraint(src: string): (segment: string) => boolean {
  const err = constraintError(src);
  if (err) throw new Error(`invalid route constraint (${src}): ${err}`);
  const prog = compileProgram(parseConstraint(src));
  return (segment) => run(prog, segment);
}

// --- Example paths (dashboard samples): deterministic strings a constraint matches.

function sampleOf(node: Node, seed: number): string {
  switch (node.t) {
    case "set": {
      const pool = node.set.neg
        ? ["x", "Q", "7", "-", "k", "M"]
        : (() => {
            const out: string[] = [];
            const r = node.set.ranges;
            for (let k = 0; k < r.length; k += 2) {
              const span = r[k + 1]! - r[k]! + 1;
              for (let j = 0; j < Math.min(span, 26); j++) out.push(String.fromCharCode(r[k]! + j));
            }
            return out;
          })();
      const choices = node.set.neg ? pool.filter((ch) => inSet(node.set, ch.charCodeAt(0))) : pool;
      return choices.length ? choices[(seed * 7 + 3) % choices.length]! : "";
    }
    case "cat":
      return node.items.map((it, k) => sampleOf(it, seed + k * 13)).join("");
    case "alt":
      return sampleOf(node.alts[seed % node.alts.length]!, seed);
    case "rep": {
      const extra =
        node.max === Infinity ? 2 + (seed % 4) : Math.min(node.max - node.min, 1 + (seed % 3));
      const times = node.min + Math.max(0, extra);
      let s = "";
      for (let k = 0; k < times; k++) s += sampleOf(node.node, seed + k * 5 + 1);
      return s;
    }
  }
}

/**
 * Up to `count` distinct concrete paths a pattern key matches, for previews
 * and the wizard. Unconstrained params are filled with their names
 * (`/lp/:slug` → `/lp/slug`), catch-alls `*` with nothing. [key] for an exact path.
 */
export function exampleRoutePaths(key: string, count = 3): string[] {
  if (!isRoutePattern(key)) return [key];
  const route = compileRoute(key);
  if (typeof route === "string") return [];
  const out = new Set<string>();
  for (let seed = 0; seed < count * 8 && out.size < count; seed++) {
    let path = "";
    for (const s of route.segments) {
      if (s.kind === "literal") path += `/${s.text}`;
      else if (s.rest === "*") continue;
      else if (s.constraint) path += `/${sampleOf(parseConstraint(s.constraint), seed)}`;
      else path += `/${s.name}`;
    }
    path ||= "/";
    if (route.match(path)) out.add(path);
  }
  return [...out];
}
