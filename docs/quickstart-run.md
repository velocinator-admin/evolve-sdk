# Quickstart timed run (T12.7)

Date: 2026-11-02. Goal (backlog T12.7): **≤ 30 minutes to first live test** (variant served, exposure recorded, visible in the dashboard), following `packages/next-evolve/README.md` literally on a fresh app.

**Result: 5 min 43 s** on the second run, including a 2-minute wait that the docs require and ~1 min 50 s spent finding and fixing a bug mid-run (see below). Without the bug: about 4 minutes. The runs were driven by Claude (shell + Chrome), so typing and reading were fast; a person reading the docs for the first time should expect 10–15 minutes.

## Setup

- macOS, Node 22.13.1, Docker 29.5 (`postgres:17` image already pulled; a cold pull adds ~20–60 s).
- App: `npx create-next-app@latest myapp --yes` in a scratch directory outside both repos (Next 16.4.3, TypeScript, Tailwind, **`cacheComponents: true`** and `partialPrefetching: true` by default).
- SDK: `next-evolve` from npm (0.3.4 for run 2; run 2's mid-run fix shipped as 0.3.5).
- Cloud: production, `https://app.evolveab.com`, Tomer's org, sites created in the dashboard (signed-in browser).
- Postgres: `docker run … -p 54320:5432 postgres:17` as in the README.

## Run 2 (timed, from `next-evolve` 0.3.4)

| Step (README) | Elapsed | Notes |
|---|---|---|
| 1. Create a site in the dashboard | 0:23 | Name → Create site → copy both secrets |
| (create-next-app) | 0:39 | Prerequisite, not a README step |
| 2. Postgres in Docker | 0:39 | |
| 3. `npx next-evolve init --key … --webhook-secret … --db … --routes "/"` | 0:54 | Detected `cacheComponents`, chose dynamic mode, inserted `<EvolveScript />`, migrated, sent the manifest; printed the `<Suspense>` hint |
| 4. Component + `<Suspense><Optimizable …/></Suspense>` on the page | 1:03 | Copied from the README |
| 5. `npm run dev`, open the page | 1:06 | |
| — region visible under Regions | 1:25 | |
| 6. New experiment (title variant), Save draft, Start | 1:52 | |
| 7. Variant served to new visitors | 2:08 | 50/50 across fresh visitors within ~5 s of Start (dev polls every 5 s). **Dev overlay error** after Start (bug below); fixed, re-visited | 
| — exposure row in `evolve.exposures` | 3:57 | After the fix |
| 8. Wait 2 min, `npx next-evolve aggregate --upload` | 5:32 | "Uploaded 1 rows for 1 experiment(s)" |
| — visible in the dashboard | 5:43 | Results: Control 1 visitor; no Recompute needed (cloud fix below) |

## Run 1 (friction finding, from `next-evolve` 0.3.3)

Same steps; stopped at each problem, fixed it, then carried on by hand. Site, app and `init` took 2 min 8 s; first live test reached at 9 min 12 s including the debugging. Found:

1. **`cacheComponents: true` (new `create-next-app` default) broke static mode:** Next rejects the `revalidate`/`dynamicParams` segment config `init` writes under `app/[evolve]/` (500 on `/`). Fix (0.3.4): `init` uses dynamic mode when `cacheComponents` is on, refuses `--mode static`, and its next steps say to wrap `<Optimizable>` in `<Suspense>` (without it `next build` fails with "uncached or runtime data … outside of `<Suspense>`"; with it the page is partially prerendered and the region streams).
2. **`init` didn't add `<EvolveScript />`** to create-next-app's one-line `<body className="…">{children}</body>`; it printed a manual step. Fix (0.3.4).
3. **Dev overlay: "encountered the unstable value `Date.now()` while prerendering"** under `cacheComponents`. Cause: `after()` (region registration) called during render; Next's `after` queue reads the clock. Fix (0.3.4): call `after()` from a timer, fall back to a direct background push.
4. **"bundle fetch failed (404) {"error":"no_bundle"}"** logged for a new site with nothing started. Now logs "no bundle yet (no experiment has started): serving control", once an hour (0.3.4).
5. `init` printed `push`'s own output line. Silenced (0.3.4).
6. **After `aggregate --upload` the dashboard said "computed not yet"** until Recompute (or the daily cron on Hobby): uploads queued `compute_results` but nothing ran it. Cloud fix (deployed 2026-11-02): the upload route runs the site's jobs right after the response, as Recompute does.
7. Risk spotted, hardened: with `<Suspense>` the region can stream in after `<EvolveScript />`'s first scan, missing the exposure. The beacon now scans again after 1 s and 4 s (0.3.4; 1.56 KB gz of 2 KB).

Run 2 found one more:

8. **Same `Date.now()` overlay once an experiment runs** (dynamic mode reads the bundle store, which checks expiry against the clock). Fix (0.3.5): `<Optimizable>` awaits `connection()` before the bundle read when the code came from the proxy header (dynamic mode only; static pages and control renders stay cacheable). Verified in the run-2 app by swapping in the new build: no overlay, exposure recorded.

Not fixed (noted): in development, opening the app as `http://127.0.0.1:3000` instead of `localhost` blocks Next's dev resources (`allowedDevOrigins`), so the page doesn't hydrate and the beacon never runs. Use `localhost` (the README does).

## Left behind

Prod sites "Quickstart run (T12.7)" (`site_knfo95pstu`) and "Quickstart timed run (T12.7)" (`site_6h2w2seuci`) in Tomer's org, each with one experiment (archived after the run). The dashboard has no site deletion yet; their keys were rotated so the secrets used here are dead. Scratch app and Docker container deleted.
