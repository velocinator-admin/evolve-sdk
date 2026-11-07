# Going to production

## Checklist

1. **Env vars.** Set these in your host's production environment (they're in `.env.local` after `init`). They're server-only; never prefix them with `NEXT_PUBLIC_`.

   | Var                     |                                                     |
   | ----------------------- | --------------------------------------------------- |
   | `EVOLVE_SECRET_KEY`     | `evk_live_…` from the dashboard                     |
   | `EVOLVE_WEBHOOK_SECRET` | `whsec_…` from the dashboard                        |
   | `EVOLVE_DATABASE_URL`   | Your production Postgres (pooled URL on serverless) |
   | `EVOLVE_TRACK_SECRET`   | Only if you use `POST /api/evolve/track`            |

   `EVOLVE_SECRET_KEY` must also be set **at build time**: `prebuild` runs `next-evolve pull`, which bakes the current bundle into the build so a fresh instance serves it before its first fetch.

2. **Migrations.** Run `npx next-evolve migrate` against the production database once, and again after upgrading `next-evolve`. It's safe to run on every deploy, for example in the build command: `next-evolve migrate && next build`.

3. **App URL.** The cloud has to know where your app lives to send the sync webhook and aggregate requests. On Vercel production it's detected (`VERCEL_PROJECT_PRODUCTION_URL`); elsewhere set `EVOLVE_APP_URL=https://your-app.com`, or register it once:

   ```sh
   npx next-evolve connect --app-url https://your-app.com
   ```

   It must be a public `https` URL.

4. **Check.** After deploying:

   ```sh
   npx next-evolve connect --test   # the cloud pings /api/evolve/sync and dry-runs /api/evolve/aggregate
   npx next-evolve doctor           # everything else
   ```

   The site's **Connect** page in the dashboard shows the same status: manifest received, bundle fetched, sync webhook, aggregate route, last aggregate. **Run connection test** there does what `connect --test` does.

5. **Firewalls and bot protection.** Evolve Cloud calls `POST /api/evolve/sync` and `POST /api/evolve/aggregate` on your app from servers without fixed IP addresses. If you use a WAF, bot protection or "attack mode" (Vercel Firewall, Cloudflare, …), add a rule that lets `/api/evolve/*` through. The requests are authenticated by their HMAC signature, so the route doesn't need other protection. If the connection test fails with `403` or a challenge page, this is why.

## Hosts

Per-host setup (Docker standalone, Netlify, Cloudflare in front): [hosting.md](hosting.md).

|                             | Vercel                                                                              | Vercel + Global Config                                                  | Node server / Docker (`next start`)                                         |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Fresh instance serves       | the build-time bundle                                                               | the bundle in Global Config (waits ≤ 20 ms), then the build-time bundle | the disk cache, then the build-time bundle                                  |
| Background refresh          | poll the cloud every 60 s (± 10%) on traffic                                        | read Global Config (5 s cache)                                          | every 60 s, plus on traffic                                                 |
| When an experiment changes  | the instance that gets the webhook updates at once; others within one poll interval | all instances within ~5 s                                               | the instance that gets the webhook at once; others within one poll interval |
| Events while the DB is down | dropped (one retry)                                                                 | dropped (one retry)                                                     | buffered, up to 10,000 rows                                                 |

"Within one poll interval" means up to ~66 s after an instance's last check, on its next request (that request is still served the old bundle; the fetch runs in the background).

An instance that sees an experiment or variant its bundle doesn't know asks the cloud at once instead of waiting for its poll (since 0.6.1). It sees one when a returning visitor's cookie names it (the proxy refreshes in the background) or when a beacon reports it (collect answers the beacon at once, then waits for the refresh after the response and counts the exposure and its vitals). That also covers a Global Config item that has fallen behind. Each instance makes at most one such fetch per 5 s, shared by the proxy, collect and the render path, so made-up ids can't turn into a cloud fetch each. A failed fetch (network or 5xx) is retried after 10 s instead of a full poll interval.

### Vercel + Global Config (recommended on Vercel)

Without it, the sync webhook reaches one instance and the rest catch up by polling. With a [Global Config](https://vercel.com/docs/edge-config) store, the sync route writes the bundle there and every instance sees it within ~5 s (each instance re-reads it at most every 5 s, on traffic). The write also happens when the instance that gets the webhook already had the version.

1. Create a Global Config store and connect it to the project.
2. Set `EVOLVE_GLOBAL_CONFIG` (the store's connection string), `EVOLVE_GLOBAL_CONFIG_ID` (`ecfg_…`), `EVOLVE_VERCEL_API_TOKEN` (a Vercel access token that can write the store) and, for a team-owned store, `EVOLVE_VERCEL_TEAM_ID`.

Bundles read from the store are verified like any other. Without the token the store is read-only and the sync route logs so. A read-only store keeps whatever bundle was last written to it, so instances fall back to their 60 s cloud poll for changes (plus the on-demand refresh above). Set the token, or remove `EVOLVE_GLOBAL_CONFIG`.

### Node server / Docker

`registerEvolve()` (in `instrumentation.ts`) polls in the background and caches the bundle on disk in `os.tmpdir()`, or `EVOLVE_CACHE_DIR`. Mount a volume there if you want restarts to survive a cloud outage. The writer flushes buffered events on `SIGTERM`.

### Pull mode: servers the cloud can't reach

If the cloud can't call your app (a firewalled or private network, no public URL), set `aggregate: { mode: "pull" }` in `evolve.config.ts` (since 0.7). `registerEvolve()` then polls `GET /v1/aggregate-requests` every 60 s with your secret key, runs each request exactly like the aggregate route would (same signature check, runner, lock and budget), and posts the signed result to `POST /v1/aggregates`. Only outbound HTTPS to the cloud is needed. The cloud switches a site to pull as soon as it polls, and back to push (if it has an app URL) when it hasn't polled for 15 minutes. The Connect page shows the mode and the last poll. Pull needs a long-running Node server (`next start`, Docker); on serverless hosts the cloud must reach `/api/evolve/aggregate` (push, the default). The sync webhook still needs the app URL; without it instances pick up new bundles from their 60 s poll.

### CDNs

On Vercel the cache keys on the rewritten path, so each variant is cached separately. Elsewhere, the proxy sets `Cache-Control: private, no-store` on tested routes. If a CDN in front of your app ignores that and caches by URL, every visitor gets whichever variant was cached first. Don't cache tested routes at the CDN. Cloudflare cache rules, Netlify (beta) and Docker: [hosting.md](hosting.md). `doctor` names the CDN it sees in front of your site and fails if a tested route came from its cache.

### Faster repeat views on Vercel (`cdnRouting`)

Any proxy on Vercel adds ~20 ms TTFB to the requests it runs on. With `cdnRouting` (opt-in, since 0.6) a returning visitor's views within `maxAgeSeconds` (default 60 s) skip the proxy and are served from the CDN at the no-proxy TTFB. The cost: a pause or auto-rollback can take up to `maxAgeSeconds` to reach a visitor who has the route cookie. Set it up with `npx next-evolve init --cdn-routing`; details and the trade-off in [configuration.md](configuration.md#cdn-routing-cdnrouting). It pays off for visitors who come back to a tested page within the window (navigating back to `/`, reloads); a funnel where most traffic is first views barely changes.

### Serverless functions

The `/api/evolve/[...evolve]` route exports `maxDuration = 60`. Aggregation stops at 25 s by default (`aggregate.maxMs`) and returns a partial result the cloud follows up on.

## How often results update

The cloud asks your app for aggregates on a schedule set by your plan (every 5–60 minutes, plus a full recount daily; during the alpha the schedule may run only daily) and when you click **Recompute** (at most once a minute). Aggregates count data older than 2 minutes.

## Upgrading

Upgrade with your package manager, run `npx next-evolve migrate`, deploy. The SDK tells the cloud which protocol versions it speaks; the cloud supports the current and the previous one and shows "upgrade required" in the dashboard at least 90 days before dropping one.
