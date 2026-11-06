# What leaves your server

Raw events (exposures, goal events, identities, page views) are written to **your** Postgres and stay there. Evolve Cloud never connects to your database. This page lists every network call the SDK makes and every call it accepts.

## Browser → your app

`<EvolveScript />` sends page views, exposures, goal events, `identify` calls and (since 0.5) one set of Core Web Vitals per page load (LCP, CLS, INP, measured in the browser) to `/api/evolve/collect` **on your own origin**. Nothing goes to Evolve or any third party from the browser.

## Your app → Evolve Cloud

All calls go to `EVOLVE_CLOUD_URL` (default `https://api.evolveab.com`) with your secret key as a bearer token.

| Call                                                                                                               | When                                                                       | What it carries                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/bundle`                                                                                                   | Every 60 s per instance (5 s in dev), and when the sync webhook arrives    | Nothing beyond the key and an `If-None-Match` version. Gets back the signed bundle                                                                                                                                                                                                               |
| `POST /v1/manifest`                                                                                                | Once per process at startup (`registerEvolve`), `next-evolve push`, `init` | `routes` and their modes from `evolve.config.ts`; goal definitions from `evolve.goals.ts` (value functions become `{ kind: "local-fn" }`); `next-evolve` and Next.js versions; the protocol versions the SDK speaks; your public app URL if known (`EVOLVE_APP_URL`, or Vercel's production URL) |
| `POST /v1/regions`                                                                                                 | The first time a page renders a region, once per process                   | The region id, the JSON Schema of its editable props, the control props (schema fields only, as written in your code) and the page path                                                                                                                                                          |
| Aggregate responses                                                                                                | Answering the cloud's aggregate request (below)                            | Signed counts and sums                                                                                                                                                                                                                                                                           |
| `GET /v1/site`, `PUT /v1/site/app-url`, `POST /v1/site/test`, `POST /v1/aggregates/request`, `POST /v1/aggregates` | Only from the CLI (`init`, `connect`, `doctor`, `aggregate`)               | Your app URL; the same aggregate counts as below                                                                                                                                                                                                                                                 |

## Evolve Cloud → your app

Both routes check an HMAC signature made with `EVOLVE_WEBHOOK_SECRET` (shared only between your app and the cloud), a 5-minute clock window and a replay check.

| Call                         | What it carries                                                                                                                 | What your app sends back                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/evolve/sync`      | "The bundle changed" (site, version, time), or a ping. No configuration: a forged call can at most cause one extra bundle fetch | `202`                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/evolve/aggregate` | Which experiments, variants and goal definitions to count, from which day, up to which time                                     | Per experiment × variant × goal × day of first exposure: units, conversions, value sum and sum of squares (and the same for "mature" units whose window has passed). Tested page views per day. Only when the request asks (SDK 0.5+): Core Web Vitals histograms, see below. Per-goal error messages if a query failed. Duration and SDK version. Signed with the webhook secret |

### Core Web Vitals (0.5+)

The collect route turns each page load's LCP, CLS and INP into a count in a fixed bin (`VITALS_BINS` in `@next-evolve/protocol`, e.g. "LCP between 2,250 and 2,500 ms") for each experiment and variant shown on that page, in `evolve.vitals_daily`. No visitor id, path or timestamp is stored with it. When the cloud's aggregate request has a `vitals` field, the response adds one histogram per experiment × variant × metric × day: the list of bin counts. That is all the cloud learns about page speed; it uses it to pause a variant that makes pages clearly slower than control. SDKs before 0.5 store and send no vitals.

### Page fetch for AI suggestions (`EvolveBot`)

When you ask the cloud to suggest variants for a region, it may fetch the public page that region lives on, to read its visible text. The text is cached per page for 24 hours (and until your manifest changes), so that's about once per page per day; a failed fetch isn't cached and is tried again on the next suggestion. It's an anonymous `GET` (no cookies, no key, no redirects followed, 5 s timeout, at most 1 MB) to your site's domain, with the user agent `EvolveBot/1.0 (+https://evolveab.com/bot)`. The SDK treats that user agent as a bot, so your site serves it control, sets no cookie and records nothing. It sees exactly what any anonymous visitor sees. Only the page's text (at most 4,000 characters) is kept, to write better suggestions.

**Never sent:** visitor ids (`evolve_id`), your user ids, IP addresses, user agents, event props, page-view paths, individual events or timestamps. The cloud's database has no column for them, and a test fails if one is added.

## Your app → Vercel (optional)

With Vercel Global Config configured (`EVOLVE_GLOBAL_CONFIG*`), the sync route writes the signed bundle to your own Global Config store through `api.vercel.com`. It's the same bundle the app downloaded.

## What the cloud stores about your site

Your account and sites, keys (hashed) and the webhook secret (encrypted), the manifest and regions above, experiments and variants, the signed bundles, the aggregate counts per day, computed results, and a log of its calls to your app (status, timing, and the first 200 bytes of an error response).
