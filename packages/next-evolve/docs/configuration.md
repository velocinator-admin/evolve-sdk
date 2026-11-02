# Configuration and environment variables

## `evolve.config.ts`

```ts
import { defineConfig } from "next-evolve/config";

export default defineConfig({
  routes: {
    "/": { mode: "static" },
    "/pricing": { mode: "static" },
    "/features": { mode: "dynamic" },
  },
  // everything below is optional; these are the defaults
  store: "auto",
  sync: { pollSeconds: 60 }, // 5 in development
  database: { urlEnv: "EVOLVE_DATABASE_URL" },
  aggregate: { maxMs: 25_000, statementTimeoutMs: 20_000 },
  cookies: { maxAgeDays: 365, domain: undefined },
  consent: undefined, // (req: Request) => boolean
  bots: { extraPatterns: [] },
  debug: process.env.NODE_ENV !== "production",
});
```

| Option                         |                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes`                       | Pages Evolve may test, by exact path (no wildcards or `[params]`, can't start with `/ev_`). `mode`: `"static"` (the page lives under `app/[evolve]/`, cached per variant) or `"dynamic"` (the page stays put, rendered per request). Add a route here **and** to the proxy matcher; `doctor` checks both |
| `store`                        | `"auto"` uses Vercel Global Config when its env vars are set, else memory. `"memory"` or `"global-config"` force one                                                                                                                                                                                     |
| `sync.pollSeconds`             | How often each instance checks for a new bundle (± 10% jitter)                                                                                                                                                                                                                                           |
| `database.urlEnv`              | Which env var holds the database URL                                                                                                                                                                                                                                                                     |
| `aggregate.maxMs`              | Time budget for one aggregate request; past it the response is partial and the cloud asks again                                                                                                                                                                                                          |
| `aggregate.statementTimeoutMs` | Postgres `statement_timeout` per aggregation query                                                                                                                                                                                                                                                       |
| `cookies.maxAgeDays`           | Lifetime of `evolve_id` and `evolve_a`                                                                                                                                                                                                                                                                   |
| `cookies.domain`               | Set to `.example.com` to share assignments across subdomains                                                                                                                                                                                                                                             |
| `consent`                      | Return `false` to serve control and set no cookies (e.g. before cookie consent)                                                                                                                                                                                                                          |
| `bots.extraPatterns`           | Extra user-agent patterns (case-insensitive regular expressions) treated as bots                                                                                                                                                                                                                         |
| `debug`                        | Extra logging                                                                                                                                                                                                                                                                                            |

## Environment variables

All server-only.

| Var                       | Needed                  |                                                                                                                                                                                 |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVOLVE_SECRET_KEY`       | yes (runtime and build) | Site key `evk_live_<site>_<secret>`. Authenticates calls to the cloud                                                                                                           |
| `EVOLVE_WEBHOOK_SECRET`   | yes                     | `whsec_…`. Verifies the cloud's calls to your app and signs aggregate responses                                                                                                 |
| `EVOLVE_DATABASE_URL`     | to measure              | Your Postgres. Without it variants serve and nothing is recorded. Use the pooled URL on serverless. Never sent anywhere                                                         |
| `EVOLVE_TRACK_SECRET`     | optional                | Bearer secret for `POST /api/evolve/track`; the route is off (404) without it                                                                                                   |
| `EVOLVE_APP_URL`          | off Vercel              | Your public base URL, sent with the manifest so the cloud can reach the sync and aggregate routes. On Vercel production it defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL` |
| `EVOLVE_CACHE_DIR`        | optional                | Disk cache directory for the bundle on long-running Node (default `os.tmpdir()`)                                                                                                |
| `EVOLVE_CLOUD_URL`        | no                      | Defaults to `https://api.evolveab.com`                                                                                                                                          |
| `EVOLVE_GLOBAL_CONFIG`    | optional (Vercel)       | Global Config connection string (read)                                                                                                                                          |
| `EVOLVE_GLOBAL_CONFIG_ID` | optional (Vercel)       | Store id `ecfg_…` (writes)                                                                                                                                                      |
| `EVOLVE_VERCEL_API_TOKEN` | optional (Vercel)       | Vercel token that can write the store                                                                                                                                           |
| `EVOLVE_VERCEL_TEAM_ID`   | optional (Vercel)       | For team-owned stores                                                                                                                                                           |

`init` reuses `DATABASE_URL` or `POSTGRES_URL` if you agree (it writes the value into `EVOLVE_DATABASE_URL`).

Test-only variables (`EVOLVE_UNSAFE_TEST_PUBLIC_KEY`, `EVOLVE_UNSAFE_ALLOW_TEST_KEY`) exist for the SDK's own test suite. Never set them in production: they let a test key sign bundles.

## Cookies

| Cookie      | Value                                                      | Set when                                                |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| `evolve_id` | Random visitor id                                          | First visit to a tested route with a running experiment |
| `evolve_a`  | The visitor's assignments (`experiment:variant`, up to 20) | Same, and when an assignment changes                    |
| `evolve_pv` | A signed preview token                                     | Opening a dashboard preview link (session cookie)       |

All are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` over https. None is set for bots, before consent, or without a valid bundle.

## Database

`next-evolve migrate` creates a schema named `evolve` with these tables: `exposures` (one row per visitor per experiment), `events`, `identities`, `usage_daily` (tested page views per day), `aggregate_runs` (the last 24 h of aggregate responses, for retries) and `migrations`. Your own tables aren't touched. Rows are kept until you delete them.
