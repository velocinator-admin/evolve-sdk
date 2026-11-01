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
