// Traffic simulator (spec §18, T9.5): fake visitors against a running fixture
// app, over plain HTTP. Each visitor loads a page (the proxy assigns variants
// and sets cookies), reports exposures through the beacon endpoint, and
// converts with a configured true rate, from the browser (collect) or the
// server (track). The cloud side (fake or real) then aggregates as usual.
//
//   node --experimental-strip-types apps/fixture/scripts/simulate.ts \
//     --url http://localhost:3100 --visitors 2000 --path / --goal signup_submit \
//     --rate 0.05 --rate k3j9x2:bbbbbb=0.07 [--server-share 0.2 --track-secret …]
//
// Core Web Vitals (T19.5): `--lcp 1200 --lcp s1ow01:sb0000=2900 --views 3` also
// reports an LCP per page view (log-normal around the arm's median, ms), each
// view one beacon batch with the page's `exp` pairs and a `cwv` event, as the
// browser beacon sends at pagehide. Without `--lcp` nothing changes.
//
// Soak (T19.7, run from GitHub Actions against the production fixture):
// `--rps 0.25` paces every request (page, collect, track) to stay under the
// host's bot/DDoS challenge; `--guardrail cta_click --guardrail-rate 0.3
// --guardrail-rate <var>=0.02` also sends a guardrail event with its own
// per-arm rate (one independent draw per visitor); `--stop-after-errors 20`
// stops a run that's being challenged instead of hammering it.

export type SimulateOptions = {
  /** Fixture base URL, e.g. http://localhost:3100. */
  url: string;
  visitors: number;
  /** Page each visitor lands on. */
  path?: string;
  /** Event name a conversion sends. */
  goal: string;
  /** Default true conversion rate. */
  rate: number;
  /** Per-arm true rates, keyed `exp:variant` (or just `variant`). */
  rates?: Record<string, number>;
  /** Share of conversions sent server-side via /api/evolve/track (needs trackSecret). */
  serverShare?: number;
  trackSecret?: string;
  concurrency?: number;
  /** Deterministic randomness, for tests. */
  seed?: number;
  userAgent?: string;
  /** Median LCP (ms) per page view; set to report Core Web Vitals. */
  lcp?: number;
  /** Per-arm median LCP (ms), keyed `exp:variant` (or just `variant`). */
  lcps?: Record<string, number>;
  /** Page views per visitor (each a beacon batch with vitals; default 1). */
  views?: number;
  /** At most this many requests per second, all workers together (default: no limit). */
  rps?: number;
  /** A second event per visitor (e.g. a guardrail goal's event), with its own rates. */
  guardrail?: string;
  guardrailRate?: number;
  /** Per-arm guardrail rates, keyed `exp:variant` (or just `variant`). */
  guardrailRates?: Record<string, number>;
  /** Stop the run after this many errors in a row (default: never). */
  stopAfterErrors?: number;
  /** Also return each visitor's anon id per arm (tests). */
  keepIds?: boolean;
  fetch?: typeof fetch;
};

export type SimulateResult = {
  visitors: number;
  /** Per `exp:variant`: visitors exposed, conversions sent and (with `guardrail`) guardrail events. */
  arms: Record<string, { n: number; c: number; g?: number }>;
  errors: number;
  /** Error messages and how often each happened (e.g. a host's bot challenge: "page 403 …"). */
  errorReasons?: Record<string, number>;
  /** True when `stopAfterErrors` ended the run early. */
  stopped?: boolean;
  /** With `keepIds`: anon ids per `exp:variant`, and the ones that converted. */
  ids?: Record<string, { all: string[]; converted: string[] }>;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** mulberry32: small seeded PRNG so runs are reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A log-normal factor with median 1 (σ 0.3), from two uniform draws (Box–Muller). */
function logNormal(random: () => number): number {
  const z = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.exp(0.3 * z);
}

function cookiesFrom(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    if (i > 0) out.set(pair!.slice(0, i).trim(), decodeURIComponent(pair!.slice(i + 1).trim()));
  }
  return out;
}

/** Spaces calls at least 1/rps seconds apart, across concurrent callers. */
function paced(f: typeof fetch, rps: number | undefined): typeof fetch {
  if (!rps || rps <= 0) return f;
  const gap = 1000 / rps;
  let next = 0;
  return (async (...args: Parameters<typeof fetch>) => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    return f(...args);
  }) as typeof fetch;
}

export async function simulate(o: SimulateOptions): Promise<SimulateResult> {
  const f = paced(o.fetch ?? fetch, o.rps);
  const base = o.url.replace(/\/$/, "");
  const path = o.path ?? "/";
  const random = prng(o.seed ?? Date.now());
  const ua = o.userAgent ?? UA;
  const result: SimulateResult = { visitors: 0, arms: {}, errors: 0 };
  const rateFor = (exp: string, variant: string) =>
    o.rates?.[`${exp}:${variant}`] ?? o.rates?.[variant] ?? o.rate;

  const visit = async () => {
    const page = await f(`${base}${path}`, { headers: { "user-agent": ua }, redirect: "manual" });
    await page.arrayBuffer();
    const jar = cookiesFrom(page);
    const anon = jar.get("evolve_id");
    if (!page.ok || !anon) throw new Error(`page ${page.status} without an evolve_id cookie`);
    const assigned = (jar.get("evolve_a") ?? "")
      .split(".")
      .map((p) => p.split(":") as [string, string])
      .filter(([e, v]) => e && v && v !== "x");
    const collect = (events: unknown[]) =>
      f(`${base}/api/evolve/collect`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          origin: base,
          "user-agent": ua,
          cookie: `evolve_id=${anon}`,
        },
        body: JSON.stringify({ v: 1, events }),
      }).then(async (r) => {
        await r.arrayBuffer();
        if (r.status !== 204 && !r.ok) throw new Error(`collect ${r.status}`);
      });

    const lcpFor = (exp: string, variant: string) =>
      o.lcps?.[`${exp}:${variant}`] ?? o.lcps?.[variant] ?? o.lcp;
    const views = o.lcp === undefined ? 1 : Math.max(1, o.views ?? 1);
    for (let view = 0; view < views; view++) {
      const [first] = assigned;
      const median = first ? lcpFor(first[0], first[1]) : o.lcp;
      await collect([
        { t: "pv", p: path },
        ...assigned.map(([e, v]) => ({ t: "exp", e, v, p: path })),
        ...(median === undefined
          ? []
          : [{ t: "cwv", m: "lcp", v: Math.round(median * logNormal(random)), p: path }]),
      ]);
    }
    // One draw per visitor: converts if it's under this visitor's arm rate
    // (the first experiment on the page decides; others ride along).
    const u = random();
    const [first] = assigned;
    const converts = first ? u < rateFor(first[0], first[1]) : u < o.rate;
    const guardrailFor = (exp: string, variant: string) =>
      o.guardrailRates?.[`${exp}:${variant}`] ??
      o.guardrailRates?.[variant] ??
      o.guardrailRate ??
      0;
    // Drawn only with --guardrail, so seeded runs without it are unchanged.
    const guards = o.guardrail
      ? random() < (first ? guardrailFor(first[0], first[1]) : (o.guardrailRate ?? 0))
      : false;
    for (const [e, v] of assigned) {
      const key = `${e}:${v}`;
      result.arms[key] ??= o.guardrail ? { n: 0, c: 0, g: 0 } : { n: 0, c: 0 };
      const arm = result.arms[key];
      arm.n++;
      if (converts) arm.c++;
      if (guards) arm.g!++;
      if (o.keepIds) {
        result.ids ??= {};
        result.ids[key] ??= { all: [], converted: [] };
        const ids = result.ids[key];
        ids.all.push(anon);
        if (converts) ids.converted.push(anon);
      }
    }
    result.visitors++;
    if (guards) await collect([{ t: "ev", n: o.guardrail, p: path }]);
    if (!converts) return;
    if (o.trackSecret && random() < (o.serverShare ?? 0)) {
      const r = await f(`${base}/api/evolve/track`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.trackSecret}` },
        body: JSON.stringify({ events: [{ name: o.goal, anonId: anon, source: "simulator" }] }),
      });
      await r.arrayBuffer();
      if (!r.ok) throw new Error(`track ${r.status}`);
    } else {
      await collect([{ t: "ev", n: o.goal, p: path }]);
    }
  };

  let next = 0;
  let inARow = 0;
  const worker = async () => {
    while (next < o.visitors && !result.stopped) {
      next++;
      try {
        await visit();
        inARow = 0;
      } catch (e) {
        result.errors++;
        inARow++;
        if (o.stopAfterErrors && inARow >= o.stopAfterErrors) result.stopped = true;
        const why = e instanceof Error ? e.message : String(e);
        result.errorReasons ??= {};
        result.errorReasons[why] = (result.errorReasons[why] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 8) }, worker));
  return result;
}

export function parseArgs(argv: string[]): SimulateOptions {
  const o: SimulateOptions = {
    url: "http://localhost:3100",
    visitors: 1000,
    goal: "signup_submit",
    rate: 0.05,
  };
  const rates: Record<string, number> = {};
  const lcps: Record<string, number> = {};
  const guardrailRates: Record<string, number> = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1] ?? ""];
    i++;
    switch (flag) {
      case "--url":
        o.url = value;
        break;
      case "--visitors":
        o.visitors = Number(value);
        break;
      case "--path":
        o.path = value;
        break;
      case "--goal":
        o.goal = value;
        break;
      case "--rate": {
        const eq = value.lastIndexOf("=");
        if (eq < 0) o.rate = Number(value);
        else rates[value.slice(0, eq)] = Number(value.slice(eq + 1));
        break;
      }
      case "--lcp": {
        const eq = value.lastIndexOf("=");
        if (eq < 0) o.lcp = Number(value);
        else lcps[value.slice(0, eq)] = Number(value.slice(eq + 1));
        break;
      }
      case "--rps":
        o.rps = Number(value);
        break;
      case "--guardrail":
        o.guardrail = value;
        break;
      case "--guardrail-rate": {
        const eq = value.lastIndexOf("=");
        if (eq < 0) o.guardrailRate = Number(value);
        else guardrailRates[value.slice(0, eq)] = Number(value.slice(eq + 1));
        break;
      }
      case "--stop-after-errors":
        o.stopAfterErrors = Number(value);
        break;
      case "--views":
        o.views = Number(value);
        break;
      case "--server-share":
        o.serverShare = Number(value);
        break;
      case "--track-secret":
        o.trackSecret = value;
        break;
      case "--concurrency":
        o.concurrency = Number(value);
        break;
      case "--seed":
        o.seed = Number(value);
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  o.rates = rates;
  if (Object.keys(lcps).length) o.lcps = lcps;
  if (Object.keys(guardrailRates).length) o.guardrailRates = guardrailRates;
  return o;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const t = Date.now();
  simulate(opts).then((r) => {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.log(JSON.stringify({ ...r, ms: Date.now() - t }, null, 2));
    if (r.errors) process.exitCode = 1;
  });
}
