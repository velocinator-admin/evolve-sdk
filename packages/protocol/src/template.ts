// Per-page values in variant copy (TPL-1.2, protocol 1.4.0): string props may
// hold `{var}` placeholders, filled per page from the matched route params
// (`{name}` for `/:name(…)`) or `<Optimizable vars>`. Regions register the var
// NAMES they offer (never values); the cloud only accepts placeholders a region
// declares. Pure module: no Node imports (the dashboard bundles it).

/** A var name: `{fullName}`, `{city}`. */
export const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** At most this many var names per region registration. */
export const MAX_REGION_VARS = 32;
/** Longest filled value; a longer var renders control (bounded copy). */
export const MAX_VAR_VALUE_LENGTH = 500;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g;

/** Var names referenced by placeholders anywhere in a props value (strings in objects/arrays). */
export function placeholdersIn(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER)) out.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...out].sort();
}

/** Whether a props value contains any placeholder. */
export const hasPlaceholders = (value: unknown): boolean => placeholdersIn(value).length > 0;

export type FillResult<T> = { ok: true; value: T } | { ok: false; missing: string };

/**
 * Replaces every `{var}` in string leaves with `vars[var]`. A placeholder
 * without a value (or with one over {@link MAX_VAR_VALUE_LENGTH}) fails the whole
 * fill: the caller renders control, uncounted.
 */
export function fillPlaceholders<T>(
  value: T,
  vars: Readonly<Record<string, string | undefined>>,
): FillResult<T> {
  let missing: string | null = null;
  const walk = (v: unknown): unknown => {
    if (missing !== null) return v;
    if (typeof v === "string") {
      return v.replace(PLACEHOLDER, (m, name: string) => {
        const x = Object.hasOwn(vars, name) ? vars[name] : undefined;
        if (typeof x !== "string" || x.length > MAX_VAR_VALUE_LENGTH) {
          missing ??= name;
          return m;
        }
        return x;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  return missing !== null ? { ok: false, missing } : { ok: true, value: out };
}
