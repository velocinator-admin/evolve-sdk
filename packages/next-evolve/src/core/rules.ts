// UTM rules (D75/D76): compiled once per bundle, evaluated per request with no
// I/O. A rule forces one experiment's variant for the session (`evolve_r`)
// without touching the visitor's assignment in `evolve_a`.
import type { BundlePayload, DeviceClass } from "@next-evolve/protocol";
import { logRateLimited } from "./log";

/** Session cookie: `exp:rule` pairs joined by `.`. */
export const RULE_COOKIE = "evolve_r";
/** Default geo header (Vercel). Override with `geoHeader` in evolve.config.ts. */
export const DEFAULT_GEO_HEADER = "x-vercel-ip-country";
const MAX_RULE_ENTRIES = 20;
/** Inputs longer than this are cut before matching (bounds regex work per request). */
const MAX_INPUT = 512;
const ENTRY_RE = /^([a-z0-9]{6}):([a-z0-9]{6})$/;

/** What conditions can test, read lazily from the request. */
export type RuleFacts = {
  get(field: string): string | null;
};

type Test = (facts: RuleFacts) => boolean;
export type CompiledRule = { id: string; exp: string; var: string; test: Test };
export type CompiledRules = {
  /** Rules per experiment, in bundle order (only those that compiled). */
  byExp: ReadonlyMap<string, readonly CompiledRule[]>;
  byId: ReadonlyMap<string, CompiledRule>;
};

const EMPTY: CompiledRules = { byExp: new Map(), byId: new Map() };
const compiled = new WeakMap<BundlePayload, CompiledRules>();

const lower = (s: string) => s.toLowerCase();

function compileCond(c: { f: string; op: string; v: string | string[] }): Test | null {
  const { f, op, v } = c;
  if (!FIELDS.has(f)) return null;
  // eq / in / prefix compare case-insensitively (UTM values vary in case); `re` is as written.
  switch (op) {
    case "eq": {
      if (typeof v !== "string") return null;
      const want = lower(v);
      return (x) => {
        const got = x.get(f);
        return got !== null && lower(got) === want;
      };
    }
    case "in": {
      if (!Array.isArray(v)) return null;
      const set = new Set(v.map(lower));
      return (x) => {
        const got = x.get(f);
        return got !== null && set.has(lower(got));
      };
    }
    case "prefix": {
      if (typeof v !== "string") return null;
      const want = lower(v);
      return (x) => {
        const got = x.get(f);
        return got !== null && lower(got).startsWith(want);
      };
    }
    case "re": {
      if (typeof v !== "string" || v.length > 200) return null;
      let re: RegExp;
      try {
        re = new RegExp(v);
      } catch {
        return null;
      }
      return (x) => {
        const got = x.get(f);
        return got !== null && re.test(got);
      };
    }
    default:
      return null;
  }
}

const FIELDS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "country",
  "device",
]);

/**
 * The bundle's rules, compiled once per bundle object. A rule with a condition
 * this SDK doesn't know or can't compile (bad regex, unknown field or
 * operator) is skipped and logged; it never throws on the request path.
 */
export function compileRules(bundle: BundlePayload): CompiledRules {
  const hit = compiled.get(bundle);
  if (hit) return hit;
  if (!bundle.rules?.length) {
    compiled.set(bundle, EMPTY);
    return EMPTY;
  }
  const byExp = new Map<string, CompiledRule[]>();
  const byId = new Map<string, CompiledRule>();
  for (const r of bundle.rules) {
    const tests: Test[] = [];
    for (const c of r.when) {
      const t = compileCond(c as { f: string; op: string; v: string | string[] });
      if (!t) {
        tests.length = 0;
        break;
      }
      tests.push(t);
    }
    if (tests.length === 0 || tests.length !== r.when.length) {
      logRateLimited(
        `rule:${r.id}`,
        `rule ${r.id} has a condition this SDK can't evaluate; skipped`,
      );
      continue;
    }
    const test: Test =
      tests.length === 1
        ? tests[0]!
        : (x) => {
            for (const t of tests) if (!t(x)) return false;
            return true;
          };
    const rule: CompiledRule = { id: r.id, exp: r.exp, var: r.var, test };
    byId.set(r.id, rule);
    const list = byExp.get(r.exp);
    if (list) list.push(rule);
    else byExp.set(r.exp, [rule]);
  }
  const out = { byExp, byId };
  compiled.set(bundle, out);
  return out;
}

/** Device class from the user agent (and the `Sec-CH-UA-Mobile` hint when sent). */
export function deviceClass(ua: string | null, chMobile?: string | null): DeviceClass {
  if (chMobile === "?1") return "mobile";
  if (!ua) return "desktop";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return "mobile";
  return "desktop";
}

/** Referrer host: lowercased, no scheme, port or leading `www.`. Null when absent or malformed. */
export function referrerHost(referer: string | null): string | null {
  if (!referer) return null;
  try {
    const h = new URL(referer).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h || null;
  } catch {
    return null;
  }
}

/** Lazily reads condition fields from a request (each at most once). */
export function requestFacts(
  url: URL,
  headers: { get(name: string): string | null },
  geoHeader: string,
): RuleFacts {
  const cache = new Map<string, string | null>();
  const read = (f: string): string | null => {
    switch (f) {
      case "ref":
        return referrerHost(headers.get("referer"));
      case "country": {
        const c = headers.get(geoHeader);
        return c ? c.trim().toUpperCase() : null;
      }
      case "device":
        return deviceClass(headers.get("user-agent"), headers.get("sec-ch-ua-mobile"));
      default:
        return url.searchParams.get(f);
    }
  };
  return {
    get(f) {
      if (cache.has(f)) return cache.get(f)!;
      const raw = read(f);
      const v = raw === null ? null : raw.slice(0, MAX_INPUT);
      cache.set(f, v);
      return v;
    },
  };
}

/** First rule of `exp` that matches, or null. */
export function firstMatch(
  rules: CompiledRules,
  exp: string,
  facts: RuleFacts,
): CompiledRule | null {
  const list = rules.byExp.get(exp);
  if (!list) return null;
  for (const r of list) if (r.test(facts)) return r;
  return null;
}

/** Parses `evolve_r`. Malformed entries are dropped. */
export function parseRuleCookie(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const entry of raw.split(".")) {
    const m = ENTRY_RE.exec(entry);
    if (m && !out.has(m[1]!) && out.size < MAX_RULE_ENTRIES) out.set(m[1]!, m[2]!);
  }
  return out;
}

export function serializeRuleCookie(entries: ReadonlyMap<string, string>): string {
  return [...entries]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, MAX_RULE_ENTRIES)
    .map(([e, r]) => `${e}:${r}`)
    .join(".");
}

/**
 * The rule that holds for `exp` from the session cookie, if it is still valid:
 * the rule is in this bundle (and compiled) and still belongs to `exp`.
 */
export function sessionRule(
  rules: CompiledRules,
  cookie: ReadonlyMap<string, string>,
  exp: string,
): CompiledRule | null {
  const id = cookie.get(exp);
  if (!id) return null;
  const r = rules.byId.get(id);
  return r && r.exp === exp ? r : null;
}

/**
 * Per experiment on the route (D76): a still-valid rule from the session
 * cookie, else the first rule that matches this request. Returns the forced
 * variants and the cookie to write (null when unchanged).
 */
export function resolveRules(
  bundle: BundlePayload,
  exps: readonly string[],
  cookieRaw: string | undefined,
  facts: () => RuleFacts,
): { forced: Map<string, { rule: string; var: string }>; cookie: string | null } {
  const forced = new Map<string, { rule: string; var: string }>();
  const rules = compileRules(bundle);
  if (rules.byId.size === 0 && !cookieRaw) return { forced, cookie: null };
  const cookie = parseRuleCookie(cookieRaw);
  let changed = false;
  // Entries whose rule left the bundle are dropped.
  for (const exp of [...cookie.keys()]) {
    if (!sessionRule(rules, cookie, exp)) {
      cookie.delete(exp);
      changed = true;
    }
  }
  let f: RuleFacts | null = null;
  for (const exp of exps) {
    if (bundle.routing.experiments[exp]?.status !== "running") continue;
    let r = sessionRule(rules, cookie, exp);
    if (!r) {
      if (!rules.byExp.has(exp)) continue;
      f ??= facts();
      r = firstMatch(rules, exp, f);
      if (!r) continue;
      cookie.set(exp, r.id);
      changed = true;
    }
    forced.set(exp, { rule: r.id, var: r.var });
  }
  return { forced, cookie: changed ? serializeRuleCookie(cookie) : null };
}
