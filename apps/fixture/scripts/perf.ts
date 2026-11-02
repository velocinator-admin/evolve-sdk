// T12.2 perf (spec §6.6, SRV-1.5): server time Evolve adds to a request, measured
// on `next start`. Two builds of this fixture run side by side:
//   - "evolve": the normal build (proxy, instrumentation, bundle from a fake cloud);
//   - "baseline": EVOLVE_PERF_BASELINE=1 (no proxy, no instrumentation; see next.config.ts).
// Each sample asks the evolve app for a page, then the baseline app for the page the
// proxy rewrote to (`x-middleware-rewrite`), so both serve the same bytes. Requests
// alternate between the two apps one at a time, which keeps drift out of the diff.
//
//   pnpm --filter fixture build   # the evolve build (once)
//   node --experimental-strip-types apps/fixture/scripts/perf.ts [--requests 2000] [--out file.json]
//
// Against two deployed URLs instead (e.g. Vercel): --with https://a… --without https://b…
// Exits 1 when any scenario adds ≥ 5 ms at p95.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appEnv, HUMAN_UA, M1_BUNDLE } from "../e2e/env.ts";

const print = (s: string) => process.stdout.write(`${s}\n`);
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLOUD_PORT = 4020;
const EVOLVE_PORT = 3120;
const BASELINE_PORT = 3121;
const BUDGET_MS = 5;
const BOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const { values: args } = parseArgs({
  options: {
    requests: { type: "string", default: "2000" },
    warmup: { type: "string", default: "200" },
    concurrency: { type: "string", default: "16" },
    with: { type: "string" },
    without: { type: "string" },
    rebuild: { type: "boolean", default: false },
    out: { type: "string" },
  },
});
const N = Number(args.requests);
const WARMUP = Number(args.warmup);
const C = Number(args.concurrency);

type Res = { status: number; ttfb: number; total: number; headers: http.IncomingHttpHeaders };

const agents = {
  http: new http.Agent({ keepAlive: true }),
  https: new https.Agent({ keepAlive: true }),
};

/** One GET; TTFB = time to response headers. The body is read and dropped. */
function get(url: string, headers: Record<string, string>): Promise<Res> {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = mod.get(
      u,
      { headers, agent: u.protocol === "https:" ? agents.https : agents.http },
      (res) => {
        const ttfb = performance.now() - t0;
        res.on("data", () => {});
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ttfb,
            total: performance.now() - t0,
            headers: res.headers,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
  });
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};
const stats = (xs: number[]) => ({
  p50: round(pct(xs, 50)),
  p95: round(pct(xs, 95)),
  p99: round(pct(xs, 99)),
});
const round = (x: number) => Math.round(x * 1000) / 1000;

function cookiesFrom(h: http.IncomingHttpHeaders): string {
  return (h["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
}

type Scenario = {
  name: string;
  path: string;
  ua?: string;
  /** "new": no cookies each time (assignment + Set-Cookie); "returning": one visitor's cookies. */
  visitor: "new" | "returning";
};

const SCENARIOS: Scenario[] = [
  { name: "/ static, returning visitor", path: "/", visitor: "returning" },
  { name: "/ static, new visitor", path: "/", visitor: "new" },
  { name: "/pricing static, returning visitor", path: "/pricing", visitor: "returning" },
  { name: "/features dynamic, returning visitor", path: "/features", visitor: "returning" },
  { name: "/ static, bot", path: "/", ua: BOT_UA, visitor: "new" },
];

type ScenarioResult = {
  name: string;
  target: string;
  with: ReturnType<typeof stats>;
  without: ReturnType<typeof stats>;
  addedP50: number;
  addedP95: number;
  serverTiming: ReturnType<typeof stats>;
  errors: number;
};

async function runScenario(
  withUrl: string,
  withoutUrl: string,
  s: Scenario,
): Promise<ScenarioResult> {
  const ua = s.ua ?? HUMAN_UA;
  // The visitor's cookies, and the page the proxy rewrites them to.
  const first = await get(withUrl + s.path, { "user-agent": ua });
  const cookie = s.visitor === "returning" ? cookiesFrom(first.headers) : "";
  const rewrite = first.headers["x-middleware-rewrite"];
  const target = typeof rewrite === "string" ? new URL(rewrite, withUrl).pathname : s.path;
  const headers = { "user-agent": ua, ...(cookie ? { cookie } : {}) };

  const w: number[] = [];
  const wo: number[] = [];
  const st: number[] = [];
  let errors = 0;
  for (let i = 0; i < WARMUP + N; i++) {
    const a = await get(withUrl + s.path, headers);
    const b = await get(withoutUrl + target, { "user-agent": ua });
    if (a.status !== 200 || b.status !== 200) errors++;
    if (i < WARMUP) continue;
    w.push(a.ttfb);
    wo.push(b.ttfb);
    const dur = /evolve;dur=([\d.]+)/.exec(String(a.headers["server-timing"] ?? ""))?.[1];
    if (dur) st.push(Number(dur));
  }
  const ws = stats(w);
  const wos = stats(wo);
  return {
    name: s.name,
    target,
    with: ws,
    without: wos,
    addedP50: round(ws.p50 - wos.p50),
    addedP95: round(ws.p95 - wos.p95),
    serverTiming: stats(st),
    errors,
  };
}

/** Throughput at concurrency C for one URL (returning visitor on /). */
async function throughput(url: string, headers: Record<string, string>, total: number) {
  let next = 0;
  const lat: number[] = [];
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: C }, async () => {
      while (next++ < total) lat.push((await get(url, headers)).ttfb);
    }),
  );
  return { rps: Math.round((total / (performance.now() - t0)) * 1000), ttfb: stats(lat) };
}

// --- local orchestration ---------------------------------------------------------

const children: ChildProcess[] = [];
function start(cmd: string, argv: string[], env: Record<string, string>, label: string) {
  const child = spawn(cmd, argv, {
    cwd: FIXTURE,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  child.on("exit", (code) => {
    if (code && !stopping) console.error(`${label} exited ${code}\n${log}`);
  });
  children.push(child);
}
let stopping = false;
function stopAll() {
  stopping = true;
  for (const c of children) c.kill();
}
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

async function waitFor(check: () => Promise<boolean>, label: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startLocal(): Promise<{ withUrl: string; withoutUrl: string }> {
  if (!existsSync(join(FIXTURE, ".next/BUILD_ID")))
    throw new Error("no evolve build: run `pnpm --filter fixture build` first");
  if (args.rebuild || !existsSync(join(FIXTURE, ".next-baseline/BUILD_ID"))) {
    console.error("building the baseline (EVOLVE_PERF_BASELINE=1)…");
    execFileSync("pnpm", ["exec", "next", "build"], {
      cwd: FIXTURE,
      env: { ...process.env, EVOLVE_PERF_BASELINE: "1" },
      stdio: "ignore",
    });
  }
  const cloud = `http://127.0.0.1:${CLOUD_PORT}`;
  start(
    "node",
    ["../../packages/fake-cloud/dist/cli.js"],
    { FAKE_CLOUD_PORT: String(CLOUD_PORT) },
    "fake cloud",
  );
  await waitFor(async () => (await fetch(`${cloud}/health`)).ok, "fake cloud");
  const pub = await fetch(`${cloud}/__control/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(M1_BUNDLE),
  });
  if (!pub.ok) throw new Error(`publish failed: ${pub.status}`);

  const cacheDir = join(FIXTURE, ".evolve-cache/perf");
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const port = (p: number) => ["exec", "next", "start", "--port", String(p)];
  start(
    "pnpm",
    port(EVOLVE_PORT),
    {
      ...appEnv,
      EVOLVE_CLOUD_URL: cloud,
      EVOLVE_POLL_SECONDS: "60",
      EVOLVE_CACHE_DIR: cacheDir,
    },
    "evolve app",
  );
  start("pnpm", port(BASELINE_PORT), { EVOLVE_PERF_BASELINE: "1" }, "baseline app");

  const withUrl = `http://localhost:${EVOLVE_PORT}`;
  const withoutUrl = `http://localhost:${BASELINE_PORT}`;
  // The bundle is live once a new visitor gets an assignment cookie.
  await waitFor(
    async () =>
      String((await get(`${withUrl}/`, { "user-agent": HUMAN_UA })).headers["set-cookie"]).includes(
        "evolve_a=",
      ),
    "the evolve app to serve the bundle",
  );
  await waitFor(
    async () => (await get(`${withoutUrl}/ev_0`, {})).status === 200,
    "the baseline app",
  );
  return { withUrl, withoutUrl };
}

// --- main ---------------------------------------------------------------------------

const remote = Boolean(args.with && args.without);
const { withUrl, withoutUrl } = remote
  ? { withUrl: args.with!.replace(/\/$/, ""), withoutUrl: args.without!.replace(/\/$/, "") }
  : await startLocal();

const results: ScenarioResult[] = [];
for (const s of SCENARIOS) {
  console.error(`${s.name}…`);
  results.push(await runScenario(withUrl, withoutUrl, s));
}
const visitor = await get(`${withUrl}/`, { "user-agent": HUMAN_UA });
const cookie = cookiesFrom(visitor.headers);
const target = new URL(String(visitor.headers["x-middleware-rewrite"] ?? "/ev_0"), withUrl)
  .pathname;
const load = {
  concurrency: C,
  with: await throughput(`${withUrl}/`, { "user-agent": HUMAN_UA, cookie }, N),
  without: await throughput(`${withoutUrl}${target}`, { "user-agent": HUMAN_UA }, N),
};

const report = {
  at: new Date().toISOString(),
  mode: remote ? "remote" : "local next start",
  node: process.version,
  requests: N,
  warmup: WARMUP,
  scenarios: results,
  load,
};
if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

print(
  `| Scenario | Evolve TTFB p50 / p95 / p99 | Baseline p50 / p95 / p99 | Added p50 / p95 | In-proxy (Server-Timing) p50 / p95 / p99 |`,
);
print(`|---|---|---|---|---|`);
const t = (x: { p50: number; p95: number; p99: number }) =>
  `${x.p50.toFixed(2)} / ${x.p95.toFixed(2)} / ${x.p99.toFixed(2)}`;
for (const r of results) {
  print(
    `| ${r.name} | ${t(r.with)} | ${t(r.without)} | ${r.addedP50.toFixed(2)} / ${r.addedP95.toFixed(2)} | ${Number.isNaN(r.serverTiming.p50) ? "—" : t(r.serverTiming)} |`,
  );
}
print(
  `\nLoad, ${C} concurrent, ${N} requests on /: Evolve ${load.with.rps} req/s (TTFB p95 ${load.with.ttfb.p95.toFixed(2)} ms), baseline ${load.without.rps} req/s (p95 ${load.without.ttfb.p95.toFixed(2)} ms)`,
);
const errors = results.reduce((s, r) => s + r.errors, 0);
if (errors) print(`errors (non-200): ${errors}`);

const over = results.filter((r) => r.addedP95 >= BUDGET_MS);
stopAll();
if (over.length || errors) {
  console.error(
    `over budget (${BUDGET_MS} ms added p95): ${over.map((r) => r.name).join(", ") || "none"}`,
  );
  process.exit(1);
}
process.exit(0);
