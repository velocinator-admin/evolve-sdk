# Troubleshooting

Start with `npx next-evolve doctor`. It checks the env, key, database, bundle, proxy matcher, pages, `<EvolveScript />` and whether the cloud can reach your app, and says what to fix. The dashboard's **Connect** page shows the cloud's side.

## Setup

**`init`: "A secret key is needed" / "the secret key was rejected".** Pass `--key evk_live_…` (or set `EVOLVE_SECRET_KEY`). The key is shown once when you create the site; if you lost it, issue a new one on the Connect page.

**`init` printed "Add `<EvolveScript />` … to your root layout".** It couldn't find a place to insert it. Add `import { EvolveScript } from "next-evolve/client"` and put `<EvolveScript />` inside `<body>`.

**`init` printed instructions for your proxy.** You already have a `proxy.ts`/`middleware.ts`. Call `applyEvolve` first in it and add the routes plus `/(ev_.*)` to `config.matcher` ([API](api.md#next-evolveproxy)).

**A route stayed in dynamic mode.** `init` says why (top-level `[slug]`, route group, `force-dynamic`, `"use client"` page…). Dynamic mode works the same; the page just isn't cached per variant.

**`cacheComponents` errors.**
- `Route segment config "revalidate" is not compatible with nextConfig.cacheComponents`: the page was set up in static mode. Re-run `npx next-evolve init` with `next-evolve` 0.3.4 or newer (it uses dynamic mode with `cacheComponents`), or by hand: move the page back out of `app/[evolve]/`, remove the `withEvolve`/`evolveStaticParams`/`evolveMetadata` lines and set the route's mode to `"dynamic"`.
- `uncached or runtime data … accessed outside of <Suspense>` in `next build`: wrap `<Optimizable>` in `<Suspense>`.
- `encountered the unstable value Date.now()` in the dev overlay, pointing at `<Optimizable>`: upgrade to `next-evolve` 0.3.5 or newer.

**`doctor`: "Database: not migrated".** Run `npx next-evolve migrate`.

**`doctor`: "Proxy matcher … misses".** Every route in `evolve.config.ts` must be in `config.matcher`, plus `/(ev_.*)`.

## Nothing is being tested

**Every visitor sees control.** In order:
1. Is the experiment **running** (not draft or paused) and on this exact path? Paths match exactly (a trailing slash is ignored): an experiment on `/pricing` doesn't run on `/pricing/teams`.
2. Is the route in `evolve.config.ts` and the proxy matcher?
3. Does the app have a bundle? The log says `no bundle yet` or `bundle fetch failed (401)` (bad key) / `(network)` (cloud unreachable). `doctor` checks it.
4. Are you a "bot"? Headless browsers, `curl` without a browser user agent, and Lighthouse always get control.
5. Did `consent` return `false`?
6. Are you outside the traffic share? Those visitors see control and aren't counted.
7. Static mode: is the page under `app/[evolve]/` and wrapped with `withEvolve()`? In development, `<Optimizable>` warns "rendered without Evolve context" when it isn't.

**I keep seeing the same variant.** That's intended: a visitor keeps their assignment. Use a private window (each one is a new visitor), delete the `evolve_id` and `evolve_a` cookies, or use a **Preview** link from the experiment page.

**A change in the dashboard doesn't show up.** The app picks up a new bundle when the sync webhook reaches it (seconds), or by polling: within one poll interval (60 s ± 10% in production, 5 s in development) of an instance's last check, on its next request. The request that triggers the check is still served the old bundle. In local development the webhook can't reach `localhost`, so it's polling only. If production is slow, check the Connect page's "Sync webhook" status. On Vercel without Global Config, only the instance that gets the webhook updates at once.

**A variant renders control and isn't counted.** Its props failed the component's schema (the log says `variant … failed its schema`), usually because the schema changed in code after the variant was made. Add a new variant.

## Nothing is being measured

**No rows in `evolve.exposures`.**
- Is `<EvolveScript />` in the root layout? Check the browser's network tab for `POST /api/evolve/collect` (it batches every 2 s and on page hide).
- Is `EVOLVE_DATABASE_URL` set where the app runs? `GET /api/evolve/health` returns `"db": true` when it is.
- Was the visitor counted? Bots, preview sessions, visitors outside the traffic share and visitors without an `evolve_id` cookie aren't.
- Is the database up? On serverless hosts, events are dropped while it's down (one retry). On a Node server they're buffered (up to 10,000 rows) and written when it's back.

**Goal events don't count.**
- The event name must match the goal's `event` exactly, and `source`/`where` must match if set.
- Only events after the visitor's first exposure and within the goal's window count.
- Server events from webhooks or other devices need `evolve.identify(userId)` to have linked the visitor, and the event must carry that `userId`.
- New or changed goals reach the cloud when the app restarts (or `npx next-evolve push`).

## Results

**Results show nothing, or not the visit I just made.** Aggregates only count data older than **2 minutes**. Wait and click **Recompute** again (at most once a minute; a second click within a minute does nothing).

**Local development: results never update.** The cloud can't reach `localhost`. Run `npx next-evolve aggregate --upload` (2 minutes after the visits).

**Connect page: "Aggregate route ok · last error: …".** The last aggregate request failed and retries are still pending; the status turns `unhealthy` only after the retries run out. Results keep their last values (and bandit weights stay where they were) until a run succeeds. `HTTP 503 {"error":"database_error"}` means your app couldn't reach its database.

**Connection test fails.**
- `401` / `bad_signature`: `EVOLVE_WEBHOOK_SECRET` in your app doesn't match the site's. Issue a new one on the Connect page or fix the env var, then redeploy.
- `403`, `429` or an HTML challenge page: a firewall or bot protection in front of your app blocked the cloud. Let `/api/evolve/*` through ([production.md](production.md#checklist)); the routes check signatures themselves.
- `404`: the app URL is wrong, or the deploy doesn't have the `app/api/evolve/[...evolve]/route.ts` file.
- `503 not_configured`: `EVOLVE_SECRET_KEY` or `EVOLVE_WEBHOOK_SECRET` isn't set in the deployed app.
- Timeout or "no app URL": register it with `npx next-evolve connect --app-url https://…`. It must be a public https URL.

**"Window not elapsed for X% of visitors".** Those visitors' goal windows are still open, so their conversions may still arrive. Not an error.

## The site serves control after working for a while

- **The bundle expired.** If the app couldn't reach the cloud for 14 days, or the key was revoked or the site deleted, the last bundle expires and every visitor gets control. New visitors aren't recorded; returning visitors' events and server events still are. Fix the connection (check `EVOLVE_SECRET_KEY` and outbound access to `api.evolveab.com`); the next poll restores serving.
- `doctor` fails the bundle check when the current bundle is less than 7 days from expiry.

## Logs

The SDK logs with an `[evolve]` prefix, at most once a minute per message:

| Message                                                      | Meaning                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `no bundle yet (no experiment has started): serving control` | Normal for a new site                                                                            |
| `bundle fetch failed (401)`                                  | The key is wrong or revoked                                                                      |
| `bundle fetch failed (network)`                              | The cloud is unreachable; the last bundle keeps serving                                          |
| `bundle rejected: …`                                         | A bundle failed verification (wrong site, bad signature, older version) and was ignored          |
| `manifest push failed (…)`                                   | Startup couldn't send routes and goals; retried on the next start, or run `npx next-evolve push` |
| `customer DB write failed; will retry`                       | The database is unreachable (Node keeps buffering)                                               |
| `customer DB write failed; batch dropped`                    | The database is unreachable (serverless: the retry failed, those events are lost)                |
| `customer DB unavailable; dropping N buffered rows`          | The Node buffer is full (10,000 rows)                                                            |
