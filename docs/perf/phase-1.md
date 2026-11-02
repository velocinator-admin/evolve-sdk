# Phase 1 performance (T12.2)

Targets (spec §6.6, §19 item 2; SRV-1.5, DATA-1.4):

| Target | Result | Status |
|---|---|---|
| In-proxy p95 < 1 ms | 0.04–0.11 ms (`Server-Timing` on `next start`) | Met |
| Added TTFB p95 < 5 ms on `next start` | 0.45–0.59 ms | Met |
| Vercel number recorded | Pending: needs the fixture on Vercel (T12.3) | Open |
| Aggregation p95 < 5 s at 50k exposures / 1M events | 0.66 s (visitor), 0.77 s (user) | Met |
| Cloud job lag | ≤ 1 s inside a tick for 1,000 due jobs; the wait for a tick is the cron cadence | Recorded |

Measured 2026-11-01 on Tomer's MacBook (Node 22, Next 16.4.3, Postgres 17 in Docker).

## Request path: with vs. without Evolve

`apps/fixture/scripts/perf.ts` (`pnpm --filter fixture perf` after `pnpm --filter fixture build`). It runs two builds of the fixture on `next start`:

- **Evolve:** the normal build: proxy, instrumentation, a bundle with three running experiments from the fake cloud.
- **Baseline:** `EVOLVE_PERF_BASELINE=1` builds the same app with only `.tsx` files as app files, so `proxy.ts`, `instrumentation.ts` and the API routes are gone. Pages are requested at their variant paths.

Each sample requests a page from the Evolve app, then the page its proxy rewrote to (`x-middleware-rewrite`) from the baseline, so both serve the same bytes. Requests alternate one at a time (200 warm-up + 2,000 each), which keeps drift out of the difference. TTFB is time to response headers over a keep-alive connection. "Added" is Evolve minus baseline at the same percentile. The script exits 1 if any scenario adds ≥ 5 ms at p95.

All times in ms (raw numbers: [phase-1.local.json](phase-1.local.json)):

| Scenario | Evolve TTFB p50 / p95 / p99 | Baseline p50 / p95 / p99 | Added p50 / p95 | In-proxy p50 / p95 / p99 |
|---|---|---|---|---|
| `/` static, returning visitor | 0.77 / 1.12 / 1.52 | 0.46 / 0.67 / 0.98 | 0.31 / 0.45 | 0.03 / 0.04 / 0.07 |
| `/` static, new visitor (assign + Set-Cookie) | 0.68 / 1.09 / 1.49 | 0.37 / 0.61 / 0.89 | 0.31 / 0.48 | 0.05 / 0.09 / 0.15 |
| `/pricing` static, returning visitor | 0.67 / 1.64 / 2.95 | 0.45 / 1.12 / 1.81 | 0.22 / 0.52 | 0.02 / 0.07 / 0.13 |
| `/features` dynamic, returning visitor | 2.66 / 4.03 / 4.96 | 2.20 / 3.44 / 4.28 | 0.47 / 0.59 | 0.06 / 0.11 / 0.15 |
| `/` static, bot (control, no cookies) | 0.59 / 1.33 / 2.01 | 0.41 / 0.87 / 1.54 | 0.19 / 0.46 | 0.01 / 0.04 / 0.07 |

Reading it:
- Evolve's own logic (`Server-Timing`) is 0.1 ms or less at p95. Most of the ~0.3–0.5 ms added is Next running a proxy at all (the rewrite and the extra internal hop), which any proxy costs.
- Under load (16 concurrent, 2,000 requests on `/`) the two runs measured 727 vs. 650 req/s in one run and 1,636 vs. 2,844 req/s in a shorter one. A laptop running both servers, Docker and the load generator is too noisy for throughput; treat those as unmeasured until the Vercel run.

The CI micro-benchmark (`packages/next-evolve/src/proxy/proxy.test.ts`, "in-proxy p95 < 1 ms", 2,000 calls) keeps guarding the in-proxy number on every PR.

## Aggregation SQL

`packages/next-evolve/src/aggregate/attribution.perf.int.test.ts` (SDK integration suite, runs in CI): 50k exposed visitors over 10 days (half identified), 1M events over 12 days from 200k visitors, one 7-day goal, five runs per unit.

| Unit | Runs (ms) | Max |
|---|---|---|
| visitor | 416, 417, 425, 536, 660 | 0.66 s |
| user (cross-device via identities) | 588, 634, 636, 663, 772 | 0.77 s |

Budget per query is 5 s (the test fails above it); the aggregate route's whole-request budget is 25 s.

## Cloud job lag

`evolve-cloud/src/jobs/lag.perf.int.test.ts` (cloud integration suite):

- **Runner:** one tick drained 1,000 due no-op jobs in 974 ms (0.97 ms per job, ~1,000 jobs/s). Lag from due to start inside the tick: p50 537 ms, p95 928 ms. A tick has 50 s, so runner overhead isn't a limit; real jobs are bound by their own work.
- **compute_results** (3 arms × 3 goals × 30 days of buckets, 20,000 Monte Carlo draws per arm): p50 46 ms, p95 60 ms (test fails at 2 s).
- **Aggregate jobs** are bound by the customer app's response (the SQL above plus the network).
- **Waiting for a tick:** the cron cadence. On Vercel Hobby (today) the cron runs once a day, so a job can wait up to 24 h; Recompute in the dashboard runs a site's jobs inline instead. On Vercel Pro the cron runs every minute: lag ≤ 60 s plus the queue ahead of the job.

## Still to do

- **Vercel:** deploy both builds of the fixture (T12.3) and run `perf.ts --with <evolve url> --without <baseline url>`; add the numbers here. Over the internet the TTFB includes the network, so compare p50/p95 of the difference, and set `--requests` lower.
