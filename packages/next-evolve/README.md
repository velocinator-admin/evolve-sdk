# next-evolve

Self-improving Next.js sites: server-side variants with no flicker, measured in your own Postgres. Needs an Evolve Cloud account.

> Alpha. The setup below is what `npx next-evolve init` will write (E11).

## Database

Raw events (exposures, goal events, identities) stay in **your** Postgres (≥ 14), in a separate `evolve` schema. Evolve Cloud only ever receives aggregate counts.

```sh
EVOLVE_DATABASE_URL=postgres://… npx next-evolve migrate
```

Use the pooled URL on serverless hosts (e.g. Neon's `-pooler` host).

## Goals

```ts
// evolve.goals.ts
import { defineGoals } from "next-evolve/config";

export default defineGoals({
  cta_click: { event: "cta_click", window: "1d" },
  signup_page: { pageview: "/signup", window: "1d" },
  paid: {
    event: "subscription_started",
    source: "stripe",
    window: "30d",
    value: (e) => e.props.amount as number,
  },
});
```

Function values run in your app when the event is written; only `{ kind: "local-fn" }` is sent to the cloud.

## Routes and beacon

```ts
// app/api/evolve/[...evolve]/route.ts
import { createEvolveHandler } from "next-evolve/server";
import evolveConfig from "@/evolve.config";
import goals from "@/evolve.goals";

export const { GET, POST } = createEvolveHandler({ config: evolveConfig, goals });
export const maxDuration = 60;
```

Put `<EvolveScript />` (from `next-evolve/client`) in the root layout. It sends page views, exposures and clicks on `[data-evolve-goal]` elements (forms: on submit) to `/api/evolve/collect` on your own origin.

## Tracking

```ts
import { evolve } from "next-evolve/server";

await evolve.track("project_created", { userId: user.id });
await evolve.identify(user.id); // links the visitor's evolve_id cookie; first link wins
```

In the browser: `import { track, identify } from "next-evolve/client"`.

### Server-to-server events

`POST /api/evolve/track` with `Authorization: Bearer $EVOLVE_TRACK_SECRET` and `{ "events": [{ "name", "userId"?, "anonId"?, "value"?, "props"?, "source"?, "ts"?, "dedupeKey"? }] }` (≤ 500 events). Unset secret → 404; wrong bearer → 401.

### Stripe recipe

Call `evolve.track` from your own Stripe webhook handler, after you verify the signature:

```ts
// app/api/stripe/route.ts
import { evolve } from "next-evolve/server";

if (event.type === "invoice.paid") {
  const invoice = event.data.object;
  await evolve.track("subscription_started", {
    userId: invoice.metadata.userId,
    source: "stripe",
    props: { amount: invoice.amount_paid / 100 },
    dedupeKey: event.id, // Stripe retries: stored once
  });
}
```

## Aggregation

Evolve Cloud never reads your database. It sends a signed request to `POST /api/evolve/aggregate` (verified with `EVOLVE_WEBHOOK_SECRET`), and your app answers with counts and sums per experiment × variant × goal × day, signed with the same secret. No visitor or user ids leave your app. Set `EVOLVE_SECRET_KEY`, `EVOLVE_WEBHOOK_SECRET` and `EVOLVE_DATABASE_URL`; the route needs `maxDuration = 60`.

In local development the cloud can't reach `localhost`. Run the same request yourself:

```sh
npx next-evolve aggregate           # print the statistics
npx next-evolve aggregate --upload  # and send them to Evolve Cloud
```

## Sync

Your app keeps a signed copy of its configuration (the bundle) in memory and serves from it with no network call on the request path. It gets new bundles three ways:

- **Polling:** every 60 s (5 s in dev), in the background.
- **Webhook:** when you change an experiment, Evolve Cloud calls `POST /api/evolve/sync` (signed with `EVOLVE_WEBHOOK_SECRET`). The receiving instance pulls the new bundle within seconds. The webhook carries no configuration, so a forged call can at most cause one extra fetch.
- **Build time:** add `"prebuild": "next-evolve pull"` to `package.json` and pass the result to the proxy, so a fresh instance serves the last bundle before its first fetch:

```ts
// proxy.ts
import { createEvolveProxy } from "next-evolve/proxy";
import buildBundle from "./.evolve/bundle.generated";
import evolveConfig from "./evolve.config";

export const proxy = createEvolveProxy(evolveConfig, { buildBundle });
```

Add `.evolve/` to `.gitignore`. `pull` never fails the build: without a key or a reachable cloud it keeps the previous bundle or writes an empty one.

**Long-running Node (`next start`, Docker):** call `registerEvolve()` from `instrumentation.ts`. It polls in the background and keeps the last bundle on disk (`os.tmpdir()`, or `EVOLVE_CACHE_DIR`), so a restart serves it even when the cloud is unreachable.

**Vercel + Global Config (recommended on Vercel):** without it, a webhook reaches only the instance that receives it and the others catch up within 60 s. With a [Global Config](https://vercel.com/docs/edge-config) store, the sync route writes the bundle there and every instance picks it up within ~10 s. Set:

| Var                       | Purpose                                 |
| ------------------------- | --------------------------------------- |
| `EVOLVE_GLOBAL_CONFIG`    | The store's connection string (read)    |
| `EVOLVE_GLOBAL_CONFIG_ID` | The store id (`ecfg_…`), for writes     |
| `EVOLVE_VERCEL_API_TOKEN` | A Vercel token that can write the store |
| `EVOLVE_VERCEL_TEAM_ID`   | Optional, for team-owned stores         |

Bundles read from Global Config are verified like any other. With an existing proxy that calls `applyEvolve`, `await evolveReady(evolveConfig)` first (a fresh instance waits ≤ 20 ms for one read).
