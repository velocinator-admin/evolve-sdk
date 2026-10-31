/** Cookie names (spec §6.2). */
export const ANON_COOKIE = "evolve_id";
export const ASSIGN_COOKIE = "evolve_a";
export const PREVIEW_COOKIE = "evolve_pv";

/** Max experiments remembered in `evolve_a`. */
export const MAX_ASSIGNMENTS = 20;
/** Assignment value meaning "outside the experiment's traffic share". */
export const EXCLUDED = "x";

const ENTRY_RE = /^([a-z0-9]{6}):([a-z0-9]{6}|x)$/;

/** Parses `evolve_a` (`exp:var` pairs joined by `.`). Malformed entries are dropped. */
export function parseAssignments(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const entry of raw.split(".")) {
    const m = ENTRY_RE.exec(entry);
    if (m && !out.has(m[1]!) && out.size < MAX_ASSIGNMENTS) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** Serializes assignments sorted by experiment id, keeping at most {@link MAX_ASSIGNMENTS}. */
export function serializeAssignments(assigned: ReadonlyMap<string, string>): string {
  return [...assigned]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, MAX_ASSIGNMENTS)
    .map(([e, v]) => `${e}:${v}`)
    .join(".");
}
