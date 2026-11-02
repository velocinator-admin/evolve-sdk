# Concepts

## The pieces

- **Region:** a component on a page that Evolve may change, rendered with `<Optimizable id="…">`. Its id is unique per site (`a-z`, `0-9`, `-`, up to 40 characters). The component is wrapped with `optimizable(Component, schema)`; the Zod schema lists the props Evolve may set and their limits.
- **Control:** the props you pass to `<Optimizable props={…}>` in your code. Schema defaults apply.
- **Variant:** a set of prop overrides made in the dashboard. Variant props are merged over control and validated against the schema; a variant that fails the schema renders control and isn't counted. A started variant can't change (visitors already saw it); pause it and add a new one instead.
- **Experiment:** one region on one or more paths, 2–6 variants including control, a primary goal (and up to 5 secondary ones), and a traffic share. Two kinds:
  - **A/B/n test:** a fixed split. Read the result when it's decided.
  - **Bandit:** Evolve Cloud shifts traffic toward the better arm as data arrives (recomputed at most hourly, on the primary goal).
- **Goal:** what counts as success, defined in `evolve.goals.ts` (an event or a page view, a window, optional value). See [goals-and-attribution.md](goals-and-attribution.md).
- **Exposure:** the first time a visitor sees an experiment. The beacon reports it; one row per visitor per experiment in your database.

Limits enforced by the cloud: at most 3 running experiments per path and one live experiment per region.

## How a request is served

1. The **proxy** (`proxy.ts`, or `middleware.ts` on Next 15.5) runs for the routes in `evolve.config.ts`. It reads the **bundle** from memory, picks a variant per running experiment and rewrites (static mode) or tags (dynamic mode) the request. It makes no network call; Evolve's part takes well under a millisecond.
2. The page renders. `<Optimizable>` looks up the chosen variant's props and renders the component with them, inside a `<div style="display:contents" data-evolve-…>` marker.
3. `<EvolveScript />` in the browser sends a page view and one exposure per marked region to `/api/evolve/collect` **on your own origin**. Your app writes them to your Postgres.
4. On a schedule, Evolve Cloud sends a signed **aggregate request** to `/api/evolve/aggregate`. Your app runs SQL on its own database and answers with counts and sums per experiment × variant × goal × day. The cloud computes results (Bayesian; P(beat control), lift, risk) and, for bandits, new weights.
5. When anything changes (start, pause, new weights), the cloud signs a new bundle and calls `/api/evolve/sync`; your app fetches the bundle. Apps also poll for it every 60 seconds.

## The bundle

The bundle is your site's serving configuration: which experiments run on which paths, their traffic share and weights, and each variant's props. It contains no results, priors, goal logic or plan rules.

- It's signed by Evolve Cloud (Ed25519). The SDK ships the public key and rejects anything that doesn't verify, belongs to another site, or is older than the one it has.
- It expires 14 days after it was signed. The cloud re-signs every active site's bundle daily. If your app can't reach the cloud, it keeps serving the last bundle until it expires, then serves control.
- Sources, freshest first: memory, then (Vercel + Global Config) the store, then (long-running Node) a disk cache, then the build-time copy `next-evolve pull` writes to `.evolve/bundle.generated.ts` during `prebuild`.

## Static and dynamic mode

Each route in `evolve.config.ts` has a mode.

|                     | Static (default)                                                         | Dynamic                                                                                       |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Page file           | Moved to `app/[evolve]/<route>/page.tsx` and wrapped with `withEvolve()` | Stays where it is                                                                             |
| What the proxy does | Rewrites `/pricing` to `/<code>/pricing` (the code names the variants)   | Passes the code in a request header                                                           |
| Caching             | One cached (ISR) render per variant                                      | Rendered per request                                                                          |
| Use for             | Marketing pages                                                          | Pages that are already dynamic, apps with a top-level `[slug]` route, `cacheComponents: true` |

`init` picks static unless moving the page isn't safe: a top-level dynamic segment (`app/[slug]`), a route group, `force-dynamic`, its own `generateStaticParams`, a `"use client"` page, or a layout shared with child routes. It says which reason applied.

**`cacheComponents: true`** (on in new `create-next-app` projects since Next 16.4) rejects the segment config static mode uses, so `init` uses dynamic mode for every route. Wrap each `<Optimizable>` in `<Suspense>`: the region then streams in after the static shell, and the rest of the page stays prerendered.

Direct requests to `/ev_…` paths return 404; they exist only as rewrite targets. In static mode, `evolveMetadata()` sets the canonical URL to the original path and marks variant renders `noindex`.

`<Optimizable>` is for pages; inside layouts it isn't supported yet.

## Who gets a variant

- **New visitors** on a route with a running experiment get two cookies: `evolve_id` (a random id) and `evolve_a` (their assignments). Both are `HttpOnly`, `SameSite=Lax`, `Secure` on https, and last 365 days by default. A visitor keeps their variant on later visits.
- **Traffic share:** visitors outside the share see control and aren't counted.
- **Bots** (by user agent: search engines, AI crawlers, link unfurlers, Lighthouse, headless browsers) always get control, no cookies, and their events are dropped. Add your own patterns with `bots.extraPatterns`.
- **Consent:** set `consent: (req) => boolean` in `evolve.config.ts`. When it returns `false` the visitor gets control and no cookies.
- **No bundle** (new site with nothing started, or an expired bundle): control and no cookies.
- **Preview links** from the dashboard force a variant for one browser session and record nothing.
- Paused experiments are removed from the bundle; their visitors see control. Completed experiments serve the winner to everyone, uncounted, until you ship it in code and archive the experiment.

## Where things run

| In your app                             | In Evolve Cloud                                 |
| --------------------------------------- | ----------------------------------------------- |
| Variant assignment, cookies, bot filter | Experiments, variants, lifecycle                |
| Event writes to your Postgres           | Statistics, decisions, bandit weights           |
| Aggregation SQL on your database        | Scheduling aggregates, storing aggregate counts |
| Bundle verification                     | Signing bundles                                 |

The cloud never connects to your database. See [what-leaves-your-server.md](what-leaves-your-server.md).
