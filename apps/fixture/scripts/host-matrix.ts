// T23.2 host matrix: per-host results for the nightly workflow (host-matrix.yml).
//
//   host-matrix.ts record --host node --e2e e2e.json --perf perf.json --out host-node.json
//     one host's row from Playwright's JSON report and perf.ts's --out report;
//   host-matrix.ts render host-*.json
//     the Markdown table for the job summary (and the failure issue).
//
// A row is "pass", "fail", "inconclusive" (the host challenged the runner, so
// nothing was measured) or "skipped" (the host can't run without an account).
// Exits 1 from `render` when any row failed.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export type Status = "pass" | "fail" | "inconclusive" | "skipped";

export type E2eResult = {
  status: Status;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
};

export type PerfResult = {
  status: Status;
  /** Worst scenario, ms. */
  addedP95: number | null;
  inProxyP95: number | null;
  budgetMs: number;
  proxyBudgetMs: number;
  samples: number;
  challenged: number;
  errors: number;
};

export type HostRow = {
  host: string;
  e2e: E2eResult | null;
  perf: PerfResult | null;
  /** Why a row or part of it didn't run. */
  note?: string;
};

/** Hosts the matrix lists but can't run yet (no accounts, parked in the Phase 3 backlog). */
export const SKIPPED_HOSTS: HostRow[] = [
  {
    host: "netlify",
    e2e: null,
    perf: null,
    note: "skipped: needs a Netlify account (parked); docs mark Netlify beta, unverified",
  },
  {
    host: "cloudflare",
    e2e: null,
    perf: null,
    note: "skipped: needs a Cloudflare account (parked); see the Cloudflare cache-rule guide",
  },
];

type PwStats = { expected?: number; unexpected?: number; flaky?: number; skipped?: number };

/** Playwright's JSON reporter output → e2e result. All skipped = the host challenged us. */
export function e2eFromReport(report: { stats?: PwStats } | null): E2eResult | null {
  if (!report?.stats) return null;
  const s = report.stats;
  const r = {
    passed: s.expected ?? 0,
    failed: s.unexpected ?? 0,
    flaky: s.flaky ?? 0,
    skipped: s.skipped ?? 0,
  };
  const status: Status = r.failed
    ? "fail"
    : r.passed + r.flaky === 0 && r.skipped > 0
      ? "inconclusive"
      : "pass";
  return { status, ...r };
}

type PerfReport = {
  budgetMs?: number;
  proxyBudgetMs?: number;
  scenarios: {
    addedP95: number;
    serverTiming: { p95: number };
    samples?: number;
    errors: number;
    challenged?: number;
  }[];
};

const finite = (xs: number[]) => xs.filter((x) => Number.isFinite(x));
const max = (xs: number[]) => (finite(xs).length ? Math.max(...finite(xs)) : null);

/** perf.ts's report → perf result (worst scenario). */
export function perfFromReport(report: PerfReport | null): PerfResult | null {
  if (!report) return null;
  const sc = report.scenarios;
  const budgetMs = report.budgetMs ?? 5;
  const proxyBudgetMs = report.proxyBudgetMs ?? 1;
  const samples = sc.reduce((s, r) => s + (r.samples ?? 0), 0);
  const challenged = sc.reduce((s, r) => s + (r.challenged ?? 0), 0);
  const errors = sc.reduce((s, r) => s + r.errors, 0);
  const addedP95 = max(sc.filter((r) => (r.samples ?? 1) > 0).map((r) => r.addedP95));
  const inProxyP95 = max(sc.map((r) => r.serverTiming.p95));
  const over =
    (addedP95 !== null && addedP95 >= budgetMs) ||
    (inProxyP95 !== null && inProxyP95 >= proxyBudgetMs);
  // A run the host mostly challenged measured nothing worth judging.
  const status: Status =
    challenged > 0 && challenged >= samples
      ? "inconclusive"
      : over || errors - challenged > 0
        ? "fail"
        : "pass";
  return { status, addedP95, inProxyP95, budgetMs, proxyBudgetMs, samples, challenged, errors };
}

const ICON: Record<Status, string> = {
  pass: "✅ pass",
  fail: "❌ fail",
  inconclusive: "⚠️ inconclusive",
  skipped: "⏭️ skipped",
};
const ms = (x: number | null) => (x === null ? "—" : x.toFixed(2));

export function rowStatus(r: HostRow): Status {
  const parts = [r.e2e?.status, r.perf?.status].filter(Boolean) as Status[];
  if (!parts.length) return "skipped";
  if (parts.includes("fail")) return "fail";
  if (parts.includes("inconclusive")) return "inconclusive";
  return "pass";
}

export function render(rows: HostRow[]): string {
  const lines = [
    "| Host | Status | e2e | In-proxy p95 (ms) | Added p95 (ms) | Notes |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const e = r.e2e;
    const e2e = e
      ? `${ICON[e.status]}: ${e.passed} passed, ${e.failed} failed${e.flaky ? `, ${e.flaky} flaky` : ""}${e.skipped ? `, ${e.skipped} skipped` : ""}`
      : "—";
    const p = r.perf;
    const notes = [
      p ? `budgets ${p.proxyBudgetMs} ms in-proxy / ${p.budgetMs} ms added` : "",
      p?.errors ? `${p.errors} failed samples (${p.challenged} challenged)` : "",
      r.note ?? "",
    ].filter(Boolean);
    lines.push(
      `| ${r.host} | ${ICON[rowStatus(r)]} | ${e2e} | ${ms(p?.inProxyP95 ?? null)} | ${ms(p?.addedP95 ?? null)} | ${notes.join("; ")} |`,
    );
  }
  return lines.join("\n");
}

const readJson = <T>(path: string | undefined): T | null => {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      e2e: { type: "string" },
      perf: { type: "string" },
      out: { type: "string" },
      note: { type: "string" },
    },
  });
  if (cmd === "record") {
    const row: HostRow = {
      host: values.host ?? "unknown",
      e2e: e2eFromReport(readJson(values.e2e)),
      perf: perfFromReport(readJson(values.perf)),
      ...(values.note ? { note: values.note } : {}),
    };
    // A step that should have produced a report but didn't is a failure.
    if (values.e2e && !row.e2e) {
      row.e2e = { status: "fail", passed: 0, failed: 0, flaky: 0, skipped: 0 };
      row.note = [row.note, "no e2e report (the run crashed)"].filter(Boolean).join("; ");
    }
    if (values.perf && !row.perf) {
      row.perf = {
        status: "fail",
        addedP95: null,
        inProxyP95: null,
        budgetMs: 5,
        proxyBudgetMs: 1,
        samples: 0,
        challenged: 0,
        errors: 0,
      };
      row.note = [row.note, "no perf report (the benchmark crashed)"].filter(Boolean).join("; ");
    }
    const json = `${JSON.stringify(row, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, json);
    else process.stdout.write(json);
    return 0;
  }
  if (cmd === "render") {
    const rows = [
      ...positionals.map((p) => readJson<HostRow>(p)).filter((r): r is HostRow => r !== null),
      ...SKIPPED_HOSTS,
    ];
    process.stdout.write(`${render(rows)}\n`);
    return rows.some((r) => rowStatus(r) === "fail") ? 1 : 0;
  }
  console.error("usage: host-matrix.ts record|render …");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
