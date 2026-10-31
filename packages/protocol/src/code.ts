import { MAX_EXPERIMENTS_PER_ROUTE } from "./bundle";
import { ID_RE } from "./ids";

/**
 * Variant code: the URL segment the proxy rewrites to (spec §6.1).
 * `ev_` + pairs sorted by experiment id, joined by `.`:
 * `<exp>-<var>` = counted, `<exp>~<var>` = render only. `ev_0` = no assignments.
 * Codes aren't signed: tampering can only select a valid variant or control.
 */
export const CODE_RE = /^ev_(0|[a-z0-9]{6}[-~][a-z0-9]{6}(\.[a-z0-9]{6}[-~][a-z0-9]{6}){0,2})$/;
export const CONTROL_CODE = "ev_0";

export type CodePair = { exp: string; var: string; counted: boolean };

export function encodeCode(pairs: readonly CodePair[]): string {
  if (pairs.length === 0) return CONTROL_CODE;
  if (pairs.length > MAX_EXPERIMENTS_PER_ROUTE) throw new RangeError("too many pairs");
  const sorted = [...pairs].sort((a, b) => (a.exp < b.exp ? -1 : a.exp > b.exp ? 1 : 0));
  let prev = "";
  const parts: string[] = [];
  for (const p of sorted) {
    if (!ID_RE.test(p.exp) || !ID_RE.test(p.var)) throw new TypeError("invalid id in pair");
    if (p.exp === prev) throw new TypeError("duplicate experiment");
    prev = p.exp;
    parts.push(`${p.exp}${p.counted ? "-" : "~"}${p.var}`);
  }
  return `ev_${parts.join(".")}`;
}

/** Parses a code. Returns null if it is malformed, unsorted or repeats an experiment. */
export function decodeCode(code: string): CodePair[] | null {
  if (!CODE_RE.test(code)) return null;
  if (code === CONTROL_CODE) return [];
  const pairs: CodePair[] = [];
  let prev = "";
  for (const part of code.slice(3).split(".")) {
    const exp = part.slice(0, 6);
    if (exp <= prev) return null;
    prev = exp;
    pairs.push({ exp, var: part.slice(7), counted: part[6] === "-" });
  }
  return pairs;
}
