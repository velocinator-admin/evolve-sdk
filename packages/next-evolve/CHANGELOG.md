# next-evolve

## 0.9.0

### Minor Changes

- 87df7e4: Regex-constrained route params (TPL-1.1, protocol 1.4.0). Route keys in `evolve.config.ts` and the bundle may constrain a single-segment param with a regex, Next matcher style: `/:name([A-Z][A-Za-z]*-[A-Za-z-]+)` serves `/Christopher-G` but not `/pricing`; `/:name/:state/:city/:id(z[0-9]+)`. The constraint matches the whole raw segment, is at most 200 characters, and is refused (at config load, and by the cloud) when it uses capturing groups, backreferences, lookarounds, anchors, nested quantifiers or `|` inside a repeated group. Matching runs on a linear-time NFA, compiled once per bundle; the proxy benchmark includes constrained routes. Precedence: exact path → constrained pattern → unconstrained pattern → D77 specificity. Static mode maps `/:name(…)` to `app/[evolve]/[name]`, `evolveMatcher` emits the key as-is (Next's matcher accepts it), and `evolveMetadata` fills it into the canonical URL. `@next-evolve/protocol` exports the grammar, validator and matcher (`parseRouteKey`, `routeKeyError`, `constraintError`, `compileRoute`, `compareRoutes`, `exampleRoutePaths`; also as the Node-free subpath `@next-evolve/protocol/routes`) for the cloud. next-evolve 0.8 drops a constrained bundle key (it never matches, so those pages serve control), which a test against the released 0.8.0 package pins.
- 2c5328a: Per-page values in variant copy (TPL-1.2, protocol 1.4.0). Variant string props may contain `{var}` placeholders, filled per page from the matched route params (`{name}` on `/:name(…)`, catch-alls joined with `/`; static mode from the page params, dynamic mode from a proxy-set `x-evolve-vars` request header that a visitor can't supply) and from the new optional `<Optimizable vars>` prop for CMS data (`vars={{ fullName: person.fullName }}`). A variant that uses a var the page doesn't have (or a value over 500 characters) renders control for that view, marked not counted. Region registrations carry the new optional `vars: string[]`: the var names the region offers on that path, never values (omitted when empty). The aggregate request may name experiments in `pages`; the answer then carries `pages: [{ exp, n }]`, the number of distinct page paths with exposures up to `asOf` (a count only), for "pooled across N pages". `@next-evolve/protocol` adds `placeholdersIn`, `fillPlaceholders`, `VAR_NAME_RE`, `MAX_REGION_VARS` (also as `@next-evolve/protocol/template`), `PAGES_ERROR_GOAL`, and contract fixtures that 1.3.0 readers parse and verify.

### Patch Changes

- 993b924: Collect answers a beacon right away when its batch names a pair the bundle doesn't route, and records the batch after the response (`after()`) once the on-demand refresh is done. Before, the beacon request stayed open for up to 12 s. After a pause, pages a visitor still had (with `cdnRouting`, for the route cookie's lifetime) sent such beacons, and on HTTP/1.1 each one held one of the browser's 6 connections to the site, so the visitor's next page loads stalled for several seconds.
- 9284640: `init` with `cacheComponents: true` sets up static mode (the default) instead of switching to dynamic. It writes each moved page the way Next allows there: the default export is a `"use cache"` page with `cacheLife("hours")` that renders the `withEvolve` page, with no `revalidate` or `dynamicParams` exports. A page that reads `searchParams`, `cookies()` or `headers()`, a `page.ts` file and a page with its own segment config stay in dynamic mode, and init says why. `--mode dynamic` works as before. `--cdn-routing` with `cacheComponents` is refused for now.
- Updated dependencies [87df7e4]
- Updated dependencies [2c5328a]
  - @next-evolve/protocol@1.4.0

## 0.8.0

### Minor Changes

- bf38adf: Static mode works with `cacheComponents: true` (HOST-2): mark the `app/[evolve]/…` page's default export `"use cache"` with a `cacheLife`, and each variant code is cached once (control is prerendered). `doctor` no longer warns about `cacheComponents`; with it on, its Pages check fails a static page that still exports `revalidate`/`dynamicParams` or has no `"use cache"`, and says how to fix it. Docs: the pattern in concepts.md, troubleshooting updated.
- ee72c49: New `npx next-evolve wrap [route]` (SDK-5): finds the components a page renders, generates a Zod schema from their TypeScript props (strings with a max length, literal unions, numbers, booleans, optional props, primitive arrays; everything else stays a plain prop), writes an `optimizable()` export in a sibling `<file>.evolve.ts` and replaces the usage with `<Optimizable id>`. Interactive picker, `--yes`, `--component`, `--dry-run` and `--build`; the diff is always shown first, and if `tsc` (or `next build`) fails afterwards every file is restored byte-identical. See `docs/wrap.md`.
- fcdda6d: UTM rules (UTM-1, protocol 1.3.0). The proxy compiles the bundle's `rules` once per bundle and, per experiment on the route and before the normal assignment, uses a still-valid rule from the session cookie `evolve_r` or the first rule matching the request (`utm_*` query parameters, referrer host, country from the new `geoHeader` option, default `x-vercel-ip-country`, and device class). A match renders the rule's variant with the same variant code as an assigned visitor (one cached page per route and variant) and leaves `evolve_a` alone, so the visitor returns to their arm when the session ends. Bots and visitors without consent still get control, and preview links win over rules. Rules that can't be evaluated (an invalid regex, an unknown field or operator) are skipped. Exposures of a rule's variant during its session are stored with `segment` = the rule id (a visitor already counted in main stays main) and aggregated per segment; rule renders are left out of the Core Web Vitals histograms. With `cdnRouting`, a rule render sets no CDN route cookie. 20 rules evaluate in < 0.2 ms (CI benchmark).

  Route patterns (UTM-1.4): `routes` in `evolve.config.ts` and bundle routes may be Next-style patterns (`/lp/:slug`, `/docs/:path*`, `/shop/:rest+`), compiled once; an exact path wins over a pattern, then the most specific pattern (fewest params, longest static prefix). Static mode maps `/lp/:slug` to `app/[evolve]/lp/[slug]` (`init --routes "/lp/:slug"` moves the page, `doctor` checks it), the matcher carries the pattern, regions register under the pattern, and `evolveMetadata` fills the params into the canonical URL. Exact-path configs and bundles behave as before; pattern routes skip `cdnRouting`.

### Patch Changes

- e1cdf7e: `doctor` requests your live site and names the CDN in front of it from the response headers: Cloudflare (`cf-ray`, `server: cloudflare`) and Netlify warn with what to check, and a tested route served from the CDN's cache (`cf-cache-status: HIT`) fails, since every visitor would get one variant. New docs page `hosting.md`: Docker standalone, Cloudflare cache rules that never serve one variant to everyone, Netlify (beta, unverified).
- Updated dependencies [c4079ac]
  - @next-evolve/protocol@1.3.0

## 0.7.1

### Patch Changes

- e6e457b: Deleted sites fail safe (PRIV-1): when the cloud answers `410 {"error":"site_deleted"}`, the app drops its cached bundle and serves control at once instead of keeping it up to 14 days, and refuses the old bundle from the build bundle, disk cache or Global Config. `next-evolve pull` writes an empty build bundle; `doctor` and the CLI say the site was deleted. A `401` (revoked key, key rotation, a preview env with the wrong key) keeps the old behaviour: the last bundle serves until it expires. The fake cloud gains `deleted` / `rejected` site sets (`POST /__control/site`).

## 0.7.0

### Minor Changes

- b8bc6e6: Pull-mode aggregation (AGG-2): `aggregate: { mode: "pull" }` in `evolve.config.ts` makes `registerEvolve()` on a long-running Node server poll `GET /v1/aggregate-requests` every 60 s, answer each signed request with the same code as the aggregate route, and post the signed result to `POST /v1/aggregates`. For servers the cloud can't reach. Push stays the default. Protocol 1.2.0 adds `aggregatePullSchema`, `AGGREGATE_PULL_PATH` and the `aggregate-pull.json` fixture; existing messages and fixtures are unchanged.
- b8bc6e6: Local retention (OPS-1): `retentionDays` (minimum 30; unset = nothing is deleted, as before) deletes old local events, vitals days and the exposures of stopped experiments once a day, from inside aggregate requests (push or pull), in batches of 5,000 rows. It never deletes data a running or paused experiment still needs. New migration `0003_retention` (two small tables): run `npx next-evolve migrate`.

### Patch Changes

- Updated dependencies [b8bc6e6]
  - @next-evolve/protocol@1.2.0

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
