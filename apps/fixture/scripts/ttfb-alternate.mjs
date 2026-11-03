// Alternating TTFB sampler for deployed URLs (docs/perf/proxy-overhead.md).
//
//   node apps/fixture/scripts/ttfb-alternate.mjs targets.json [rounds=200] [gapMs=150]
//
// targets.json: [{ "name": "...", "url": "https://...", "cookie": "a=b; c=d" }, ...]
// The first target is the baseline. Each round requests every target once, the
// order rotated per round, over keep-alive connections, so drift hits all
// targets alike. Non-200s and Vercel challenges (x-vercel-mitigated) are
// dropped. Keep gapMs ≥ 100: one IP's rapid requests get challenged.
import { readFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const [file, rounds = "200", gap = "150"] = process.argv.slice(2);
if (!file) throw new Error("usage: ttfb-alternate.mjs targets.json [rounds] [gapMs]");
const targets = JSON.parse(readFileSync(file, "utf8"));
const data = Object.fromEntries(
  targets.map((t) => [t.name, { ttfb: [], st: [], cache: {}, dropped: 0 }]),
);

async function one(t) {
  const t0 = performance.now();
  const res = await fetch(t.url, {
    headers: { "user-agent": UA, ...(t.cookie ? { cookie: t.cookie } : {}) },
    redirect: "manual",
  });
  const ttfb = performance.now() - t0;
  await res.arrayBuffer();
  return { ttfb, res };
}

for (const t of targets) await one(t).catch(() => {}); // warm connections and caches
for (let r = 0; r < Number(rounds); r++) {
  for (let i = 0; i < targets.length; i++) {
    const t = targets[(i + r) % targets.length];
    const d = data[t.name];
    try {
      const { ttfb, res } = await one(t);
      if (res.status !== 200 || res.headers.get("x-vercel-mitigated")) d.dropped++;
      else {
        d.ttfb.push(ttfb);
        const c = res.headers.get("x-vercel-cache") ?? "-";
        d.cache[c] = (d.cache[c] ?? 0) + 1;
        const st = /evolve;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "");
        if (st) d.st.push(Number(st[1]));
      }
    } catch {
      d.dropped++;
    }
    await sleep(Number(gap));
  }
}

const base = data[targets[0].name];
console.log("| target | n | TTFB p50 | p95 | added p50 | added p95 | in-proxy p50 | cache |");
console.log("|---|---|---|---|---|---|---|---|");
for (const [name, d] of Object.entries(data)) {
  const p50 = q(d.ttfb, 0.5);
  const p95 = q(d.ttfb, 0.95);
  console.log(
    `| ${name} | ${d.ttfb.length} | ${p50.toFixed(1)} | ${p95.toFixed(1)} | ${(p50 - q(base.ttfb, 0.5)).toFixed(1)} | ${(p95 - q(base.ttfb, 0.95)).toFixed(1)} | ${d.st.length ? q(d.st, 0.5).toFixed(2) : "—"} | ${JSON.stringify(d.cache)} |`,
  );
}
