# next-evolve

## 0.6.2

### Patch Changes

- 289c182: Faster rollbacks with Global Config (T19.5). Instances re-read Global Config every 5 s instead of 10 s. The sync route now pulls the published bundle from the cloud, not the Global Config item it is about to replace. It also writes Global Config when its own instance already had the webhook's version.

## 0.6.1

### Patch Changes

- 93f290a: Stale instances no longer drop real visits (T19.5 rollback drill). On Vercel, an instance holding an older bundle dropped the exposures and vitals of an experiment started meanwhile.
  - Collect now waits for a refresh from the cloud when a beacon names an experiment or variant its bundle doesn't know. It shares a refresh already in flight instead of giving up inside the 5 s window. If that fetch predates the publish, it does a second round. It then counts what the newer signed bundle knows.
  - The proxy starts the same refresh in the background (`waitUntil`) when a returning visitor's cookie names an experiment or variant its bundle doesn't know.
  - On-demand refreshes ask the cloud directly, so a stale Global Config item can't hide a newer bundle. A failed cloud call no longer starts a new 60 s wait.
  - The proxy, collect and the render path's `fresh` pull share one budget: at most one on-demand cloud fetch per 5 s per instance.
  - A background fetch that never settles (an instance frozen without `waitUntil`) stops blocking refreshes after 15 s. Network and 5xx failures are retried after 10 s, not a full poll interval. Collect's background poll is now handed to `after()`.

## 0.6.0

### Minor Changes

- 6f1002d: Opt-in `cdnRouting` (docs/configuration.md#cdn-routing-cdnrouting): on Vercel, repeat views of static-mode routes skip the proxy (measured +0 ms TTFB instead of ~+20 ms).
  - After the proxy routes a visitor it sets a short-lived per-route cookie (`evolve_r_<hash>`, `maxAgeSeconds` = the poll interval by default) holding the variant code; `evolveRewrites(config)` in `next.config` serves the cached variant from it, and the `evolveMatcher(config)` literal in `proxy.ts` skips the proxy for it. Previews, bots, dynamic routes and malformed cookies always run the proxy. A pause or rollback reaches a returning visitor within `maxAgeSeconds`.
  - Forged codes are harmless: a code the bundle doesn't know renders control (uncounted), and the render-side fresh bundle pull is limited to one per 5 s per instance.
  - `next-evolve init --cdn-routing` writes the config flag, the matcher literal and the `next.config` rewrites; `next-evolve doctor` fails when the literal doesn't match `evolveMatcher(config)` or `next.config` doesn't call `evolveRewrites()`.
  - Off by default: without `cdnRouting`, `evolveRewrites` is `[]`, `evolveMatcher` is the plain list and the proxy is unchanged.

## 0.5.1

### Patch Changes

- 762fb42: Cold starts no longer wait on the cloud, and `next.config.ts` can import `next-evolve/config` (docs/perf/proxy-overhead.md):
  - `registerEvolve` no longer awaits the manifest push. Next awaits `register()` before an instance's first request, so a slow or unreachable cloud delayed every cold start by up to 3 s. The push now runs in the background; failures are still logged.
  - `next-evolve/config` gets a `default` export condition, so `next.config.ts` (compiled to CommonJS) can `require` it on Node ≥ 22.12 instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## 0.5.0

### Minor Changes

- 1e6e35e: Core Web Vitals storage: migration `0002_vitals` adds `evolve.vitals_daily` (counts per experiment × variant × metric × UTC day × bin; no visitor id). It only adds a table, so `next-evolve migrate` is safe on a live database. The collect route accepts `{ t: "cwv", m, v, p }` beacon events, attributes them to the counted experiment/variant pairs the same batch reports for that page (pairs in the local bundle only), and writes one upsert per batch. Bots, previews, visitors without an Evolve id, unknown pairs and out-of-range values (negative, over 10 minutes, CLS over 10) are dropped.
- 6c1b03d: The beacon measures Core Web Vitals with hand-written `PerformanceObserver`s (no new dependency): LCP (last candidate before the first input), CLS (largest session window) and INP (approximated as the longest interaction on the page, good enough to compare arms on the same page). It sends them once per document, on the first page hide, together with that page's counted experiment/variant pairs, to the same-origin collect route. No new id is sent. Skipped for browsers without these entry types and under automation (`navigator.webdriver`); the collect route drops bots and previews. The client budget is now 3 KB gzipped (the beacon is about 2.6 KB).
- d040d65: The aggregate route (and `next-evolve aggregate`) answers protocol 1.1.0's `vitals: { from }`: one `group by` over `evolve.vitals_daily` for the requested experiments and variants (only the experiments the response returns), from `from` to the request's day, pivoted into one `bins` array per experiment × variant × metric × day (at most 5,000 rows). It counts against the same time budget. If it fails, runs out of time or would exceed the cap, the response has an `errors` entry with `goal: "$vitals"` and no `vitals`. Without `vitals` in the request the response is unchanged. Docs: "What leaves your server" and "Concepts" describe the vitals histograms.

### Patch Changes

- Updated dependencies [febe201]
  - @next-evolve/protocol@1.1.0

## 0.4.1

### Patch Changes

- 7b1cbd5: "no bundle yet (no experiment has started): serving control" now logs with `console.info` instead of `console.error`, so Vercel no longer shows a new site's normal state as an error.

## 0.4.0

### Minor Changes

- Phase 1 alpha release (T12.8). `@next-evolve/protocol` 1.0.0 freezes wire protocol v1 (bundle, signatures, aggregate request/response, manifest and region schemas); no changes from 0.1.0. `next-evolve` 0.4.0 depends on it and is published as both `latest` and `alpha`.

### Patch Changes

- Updated dependencies
  - @next-evolve/protocol@1.0.0

## 0.3.5

### Patch Changes

- 9b859ff: Dynamic mode with `cacheComponents`: `<Optimizable>` awaits `connection()` before it reads the bundle, so Next no longer reports "encountered the unstable value `Date.now()` while prerendering" once an experiment runs. Static-mode pages and control renders don't call it and stay cacheable. Docs: the quickstart's Postgres port is 54320.

## 0.3.4

### Patch Changes

- f0b5717: Docs ship with the package (README quickstart + `docs/`). Works with new `create-next-app` projects: with `cacheComponents: true`, `init` uses dynamic mode (static mode's segment config is rejected there) and says to wrap `<Optimizable>` in `<Suspense>`; `init` adds `<EvolveScript />` to a one-line `<body>`; region registration no longer calls `after()` during render (Next flagged its clock read under `cacheComponents`); the beacon looks for regions that stream in after the first scan; a new site's "no bundle" is logged as such instead of as a failed fetch; `init` no longer prints `push` output.

## 0.3.3

### Patch Changes

- 9b0a086: Sync route: two identical `ping` webhooks signed in the same second both answer again (0.3.2 refused the second as a replay, so a dashboard connection test right after `next-evolve connect --test` could show a failing webhook). A replayed ping changes nothing; `bundle.updated` keeps the full replay check.

## 0.3.2

### Patch Changes

- 80ef751: Security (T12.5): the sync and aggregate routes now also refuse a signed cloud call that was already seen under another `Evolve-Delivery` id. The delivery id isn't covered by the signature, so before this a captured call could be replayed with a fresh id inside the 5-minute signature window. Calls without a delivery id are refused too.

## 0.3.1

### Patch Changes

- 38cbbbe: Collect no longer drops exposures on a cold or stale instance: when a beacon names an experiment the instance's bundle doesn't know yet, the route fetches the bundle (at most once per 5 s per instance, waiting at most 2 s) before validating.
- 354d43c: Assignment is now deterministic per visitor and experiment (a hash of `evolve_id`), so concurrent first requests from one visitor, such as a link prefetch and the click that follows, can no longer assign two different variants and leave an exposure under the variant the visitor doesn't see.

## 0.3.0

### Minor Changes

- 3b87f18: Instant sync and the CLI: the sync webhook route (live in ≤ 5 s), a disk cache and refresh interval on long-running Node, the `prebuild` build bundle (`next-evolve pull`), tagged render-side fetches, Vercel Global Config, and `npx next-evolve init` (incl. the database step and moving static pages) and `doctor`.

## 0.2.2

### Patch Changes

- Fetch the signed bundle over node:http(s) instead of `fetch`. Rendering a variant the render-side bundle didn't know yet (a newly added variant or a preview link) refetched the bundle with an uncached `fetch` inside a static page, which Next fails at runtime ("Page changed from static to dynamic").

## 0.2.1

### Patch Changes

- Exposures record when the beacon arrived (`first_at`) instead of when the batch was written, so conversions that arrive before the next flush are no longer missed by aggregation.

## 0.2.0

### Minor Changes

- Aggregation (M4): `POST /api/evolve/aggregate` answers Evolve Cloud's signed aggregate requests with sufficient statistics computed in your own Postgres (idempotent per request, one at a time, time-budgeted, signed with `EVOLVE_WEBHOOK_SECRET`). New `npx next-evolve aggregate [--upload]` runs the same locally for development.

## 0.1.0

### Minor Changes

- 87d2e91: First public release.

### Patch Changes

- Updated dependencies [87d2e91]
  - @next-evolve/protocol@0.1.0
