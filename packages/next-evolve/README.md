# next-evolve

A/B testing for the Next.js App Router that writes its own variants, runs them with no flicker, keeps visitor data in your Postgres, and ships winners as pull requests.

```sh
npx next-evolve init
```

Needs an [Evolve Cloud](https://evolveab.com/?utm_source=npm&utm_medium=directory) account: [start a 30-day free trial](https://app.evolveab.com/sign-in?trial=1&utm_source=npm&utm_medium=directory), no card needed. Without an account the SDK serves your normal pages and records nothing; see [docs/without-an-account.md](docs/without-an-account.md).

## How it works

- **No flicker.** Your Next.js proxy picks the variant from a locally cached, signed config, with no network call, and the page is rendered on the server. No anti-flicker snippet, no client-side swap.
- **Your data stays on your servers.** Exposures, goal events and identities go into your own Postgres. Evolve Cloud never connects to it; it asks your app for signed aggregate counts.
- **The cloud does the thinking.** Bayesian results, Thompson-sampling bandits, guardrail goals and auto-rollback, including Core Web Vitals.
- **AI writes the next challenger.** Generated variants pass a schema check, locked props, forbidden claims and an LLM judge, then wait in an approval queue (or run on autopilot), capped at 20% of traffic.
- **Winners come back as pull requests.** "Promote winner" opens a PR through the Evolve GitHub App, and the experiment archives itself once it merges (Growth plan and the trial).

## What leaves your server

Aggregates only: per experiment × variant × goal × day, counts and sums. Plus your config: routes, goal definitions, each region's prop schema and control props, and version numbers. Never sent: visitor ids, your user ids, IP addresses, user agents, event props, page-view paths, individual events or timestamps. The full list of every call, in both directions: [docs/what-leaves-your-server.md](docs/what-leaves-your-server.md).

Docs: [evolveab.com/docs](https://evolveab.com/docs?utm_source=npm&utm_medium=directory)

**Requirements:** Next.js 15.5 or newer with the App Router, Node 22.12 or newer, a Postgres 14+ database, and a host that runs a Node server (not `output: "export"`).

## Quickstart (about 15 minutes)

This gets you from an existing Next.js app to a running experiment in local development. A timed run on a fresh `create-next-app` reached a variant served, an exposure recorded and the visitor in the dashboard in under 6 minutes.

### 1. Create a site

Sign in at [app.evolveab.com](https://app.evolveab.com), enter a site name and click **Create site**. Copy the **secret key** (`evk_live_…`) and the **webhook secret** (`whsec_…`). They are shown only once. If you lose them, issue a new key on the site's **Connect** page.

### 2. Get a Postgres database

Evolve writes events into its own `evolve` schema, so your app's existing database is fine. For local development, Docker works:

```sh
docker run -d --name evolve-pg -e POSTGRES_PASSWORD=postgres -p 54320:5432 postgres:17
```

For production, any Postgres works (Neon, Supabase, RDS, your own). On serverless hosts use the pooled URL (for example Neon's `-pooler` host).

### 3. Run init

In your app's directory:

```sh
npx next-evolve init \
  --key evk_live_… \
  --webhook-secret whsec_… \
  --db postgres://postgres:postgres@localhost:54320/postgres \
  --routes "/"
```

`--routes` lists the pages you want to test (exact paths, e.g. `"/ /pricing"`). Add `--dry-run` first to see the diff without changing anything. `init` is safe to re-run.

It installs `next-evolve` and `zod`, checks the key, migrates the database and writes:

| File                                    | What it is                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `evolve.config.ts`                      | The routes Evolve may test, and their mode                                                                                        |
| `evolve.goals.ts`                       | What counts as success (a sample `signed_up` goal)                                                                                |
| `app/api/evolve/[...evolve]/route.ts`   | The routes the beacon and the cloud call                                                                                          |
| `proxy.ts` (`middleware.ts` on Next 15) | Picks a variant per visitor; no network call                                                                                      |
| `instrumentation.ts`                    | Registers goals and sends your config to the cloud on startup                                                                     |
| `app/layout.tsx`                        | Adds `<EvolveScript />`, the beacon                                                                                               |
| `package.json`                          | `"prebuild": "next-evolve pull"`                                                                                                  |
| `.env.local`                            | `EVOLVE_SECRET_KEY`, `EVOLVE_WEBHOOK_SECRET`, `EVOLVE_DATABASE_URL`, `EVOLVE_TRACK_SECRET` (never overwrites a line that's there) |

**Static or dynamic mode.** By default each tested page moves to `app/[evolve]/…` and is cached once per variant ("static mode"). `init` keeps a page where it is ("dynamic mode") when moving it isn't safe, and says why. If your `next.config` has `cacheComponents: true` (new `create-next-app` projects do), static pages cache themselves with `"use cache"` + `cacheLife` instead of `revalidate`, and `init` writes them that way. See [docs/concepts.md](docs/concepts.md#static-and-dynamic-mode).

If you already have a `proxy.ts`/`middleware.ts`, or `init` can't edit your layout, it prints the lines to add.

**On Vercel, add `--cdn-routing`** (opt-in, static mode) to serve repeat views from the CDN without running the proxy: any proxy costs ~20 ms TTFB on Vercel, and this removes it for returning visitors within `cdnRouting.maxAgeSeconds` (default: the poll interval, 60 s). The trade-off is that a pause or rollback can take up to that long to reach a returning visitor. See [docs/configuration.md](docs/configuration.md#cdn-routing-cdnrouting).

### 4. Make a component optimizable

**Let `wrap` do it:** `npx next-evolve wrap /pricing` finds the components the page renders, generates the Zod schema from their TypeScript props and rewrites the usage, showing the diff first and restoring every file if `tsc` fails. See [docs/wrap.md](docs/wrap.md).

Or by hand: declare which props Evolve may change with a Zod schema, next to the component:

```tsx
// components/hero.tsx
import { optimizable } from "next-evolve";
import { z } from "zod";

const heroSchema = z.object({
  title: z.string().min(3).max(60),
  cta: z.string().min(2).max(24),
});

function Hero({ title, cta }: z.infer<typeof heroSchema>) {
  return (
    <section>
      <h1>{title}</h1>
      <a href="/signup" data-evolve-goal="signup">
        {cta}
      </a>
    </section>
  );
}

export default optimizable(Hero, heroSchema);
```

Render it with `<Optimizable>` on a tested page. The props you pass are the control:

```tsx
import { Optimizable } from "next-evolve";
import Hero from "@/components/hero";

<Optimizable id="hero" component={Hero} props={{ title: "Ship faster", cta: "Start free" }} />;
```

With `cacheComponents: true` on a dynamic-mode page, wrap it in `<Suspense>` (from `react`); without it, `next build` fails with "uncached or runtime data … outside of `<Suspense>`":

```tsx
<Suspense>
  <Optimizable id="hero" component={Hero} props={{ title: "Ship faster", cta: "Start free" }} />
</Suspense>;
```

`data-evolve-goal="signup"` fires the `signup` event on click (forms: on submit). The sample goal `signed_up` in `evolve.goals.ts` counts that event.

### 5. Start the app and open the page

```sh
npm run dev
```

Open the page once. The region registers with the cloud and shows up under **Regions** in the dashboard within a few seconds.

### 6. Create and start an experiment

In the dashboard: **Regions → hero → New experiment**. Give it a name, change a prop for "Variant B" (for example the title), click **Save draft**, then **Start**.

The dev server picks up the change within about 5 seconds (60 seconds in production, or at once through the sync webhook once deployed).

### 7. See the variant and the exposure

Open the page in a private window: you get Control or Variant B (50/50) and keep it on reloads. Each new private window is a new visitor. The experiment page also has **Preview** links that force a variant without counting anything.

The exposure is written to your database:

```sh
docker exec evolve-pg psql -U postgres -c "select * from evolve.exposures"
```

### 8. See it in the dashboard

The cloud can't reach `localhost`, so in development you run the aggregation yourself. Aggregates only count data older than 2 minutes, so wait 2 minutes after the visit, then:

```sh
npx next-evolve aggregate --upload
```

The experiment page shows the visitor under **Results**. Once deployed, the cloud runs this on a schedule and you don't need the command.

### 9. Deploy

Set the four `EVOLVE_*` variables from `.env.local` in your host's production environment, deploy, then tell the cloud where the app lives and test the connection:

```sh
npx next-evolve connect --test --app-url https://your-app.com
npx next-evolve doctor
```

More in [docs/production.md](docs/production.md).

**Server the cloud can't reach?** On `next start` or Docker, set `aggregate: { mode: "pull" }` in `evolve.config.ts`: the app polls the cloud every 60 s and posts the signed results back, so only outbound HTTPS is needed ([pull mode](docs/production.md#pull-mode-servers-the-cloud-cant-reach)).

**Keep the events table small.** Set `retentionDays: 180` (minimum 30) and the SDK deletes old local rows once a day, from inside aggregate requests, in small batches. It never deletes data a running or paused experiment still needs. Unset, nothing is deleted ([retention](docs/configuration.md#retention-retentiondays)).

## Docs

- [Concepts](docs/concepts.md): regions, variants, experiments, the bundle, static vs dynamic mode, cookies, bots
- [API reference](docs/api.md): components, functions, CLI, HTTP routes
- [Wrap components for you](docs/wrap.md): `next-evolve wrap` generates schemas and `<Optimizable>` usages from your props
- [Goals and attribution](docs/goals-and-attribution.md): defining goals, tracking events, how conversions are attributed
- [Stripe recipe](docs/stripe.md): count paid subscriptions as a goal
- [Going to production](docs/production.md): env, app URL, hosting (Vercel, Docker, Node), sync, firewalls
- [What leaves your server](docs/what-leaves-your-server.md): every call the SDK makes, and what's in it
- [Without an account](docs/without-an-account.md): what the SDK does when there's no cloud
- [Configuration and environment variables](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

MIT
