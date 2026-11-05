// Reading and writing `config.matcher` in proxy.ts. Next requires the matcher
// to be a literal, so `init` writes evolveMatcher(config) out as source and
// `doctor` reads it back. Object entries (cdnRouting's `has`/`missing`) nest
// brackets, so the literal is found by bracket matching, not a regex.
import { runInNewContext } from "node:vm";
import type { MatcherEntry } from "../config/cdn";

/** Source text of the `matcher:` value (an array or a string literal), or null. */
export function matcherSource(src: string): string | null {
  const m = /\bmatcher\s*:\s*/.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const open = src[start];
  if (open === '"' || open === "'" || open === "`") {
    const end = src.indexOf(open, start + 1);
    return end === -1 ? null : src.slice(start, end + 1);
  }
  if (open !== "[") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Evaluates a matcher literal (no globals, short timeout) to plain data; null
 * when it isn't a pure literal. Next itself only accepts literals here.
 */
export function evalMatcher(text: string): unknown {
  try {
    const v = runInNewContext(`(${text})`, Object.create(null), { timeout: 50 });
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

const KEY = /^[A-Za-z_$][\w$]*$/;
function lit(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(lit).join(", ")}]`;
  if (v && typeof v === "object")
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${KEY.test(k) ? k : JSON.stringify(k)}: ${lit(x)}`)
      .join(", ")} }`;
  return JSON.stringify(v);
}

/**
 * The matcher as source: a one-line array of strings, or one entry per line
 * (indented by `indent`) once it has objects.
 */
export function formatMatcher(entries: MatcherEntry[], indent = ""): string {
  if (entries.every((e) => typeof e === "string")) return lit(entries);
  return `[\n${entries.map((e) => `${indent}  ${lit(e)},`).join("\n")}\n${indent}]`;
}
