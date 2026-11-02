# Goals and attribution

## Defining goals

Goals live in `evolve.goals.ts`, in your repo:

```ts
import { defineGoals } from "next-evolve/config";

export default defineGoals({
  cta_click: { event: "cta_click", window: "1d" },
  signup_page: { pageview: "/signup", window: "1d" },
  docs_read: { pageview: "/docs/*" },
  activated: { event: "project_created", window: "7d", unit: "user" },
  pro_signup: { event: "signup", where: { plan: "pro" } },
  paid: {
    event: "subscription_started",
    source: "stripe",
    window: "30d",
    value: (e) => e.props.amount as number,
  },
});
```

Keys are `a-z`, `0-9` and `_`, starting with a letter, up to 48 characters. Each goal is either an **event** goal or a **pageview** goal.

| Field       | Applies to | Default      |                                                                                                                                         |
| ----------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `event`     | event      | —            | The event name to count                                                                                                                 |
| `pageview`  | pageview   | —            | An exact path, or a prefix ending in `*`                                                                                                |
| `window`    | both       | `"7d"`       | How long after a visitor's first exposure a conversion still counts: `"<n>m"`, `"<n>h"` or `"<n>d"`, at most 365 days                   |
| `unit`      | both       | `"visitor"`  | `"visitor"` counts per browser; `"user"` counts per identified user across devices (needs `identify`)                                   |
| `direction` | both       | `"increase"` | `"decrease"` when lower is better                                                                                                       |
| `source`    | event      | any          | Only events with this `source`                                                                                                          |
| `where`     | event      | —            | Only events whose props equal these values                                                                                              |
| `value`     | event      | —            | Makes it a value goal (revenue per visitor instead of conversion rate): a numeric prop path (`"amount"`, `"order.total"`) or a function |

**Value functions run in your app**, when the event is written, and the result is stored with the event. The cloud only learns that the goal has a local value function (`{ kind: "local-fn" }`), never the function. A goal without `value` uses the event's own `value` if it has one.

The goal definitions (not the functions) are sent to the cloud when the app starts, so the dashboard can list them. Changing a goal's definition makes the cloud recount it from the experiment's start.

## Firing events

| From                                  | How                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------- |
| A link or button                      | `data-evolve-goal="cta_click"` (fires on click)                             |
| A form                                | `data-evolve-goal="signup"` on the `<form>` (fires on submit)               |
| Browser code                          | `track("cta_click", { plan: "pro" })` from `next-evolve/client`             |
| Server code (actions, route handlers) | `await evolve.track("signup", { userId })` from `next-evolve/server`        |
| Another service (Segment, a CRM)      | `POST /api/evolve/track` with the bearer secret ([API](api.md#http-routes)) |
| Stripe                                | `evolve.track` in your Stripe webhook handler ([recipe](stripe.md))         |

Page views are recorded by `<EvolveScript />` automatically, but stored only when a pageview goal matches the path.

## Identity

The visitor's id is the `evolve_id` cookie. Browser events and server events inside a request carry it automatically. Events from elsewhere (webhooks, another device, a background job) only have your user id. Call `evolve.identify(userId)` once when a visitor signs up or signs in to link the two; from then on, events with that `userId` count for the visitor's experiments. The first link for a visitor wins.

## Attribution

For each experiment and goal, Evolve counts, per variant:

- **Units:** visitors (or users, for `unit: "user"`) exposed to the variant. A visitor's variant is the one in their first exposure, and that never changes (intention to treat).
- **Conversions:** units with at least one matching event in **[first exposure, first exposure + window)**. Events before the exposure don't count.
- **Value:** the sum of matching events' values per unit, for value goals.

Events match a unit by visitor id, or by user id through `identify`. Bots, visitors outside the traffic share and preview sessions aren't units.

Results are grouped by the day of each unit's first exposure (UTC), so recent days stay "open" until their window has passed. The experiment page says "Window not elapsed for X% of visitors" while conversions may still arrive. Aggregates only count data older than 2 minutes.

The SQL runs in your database, triggered by a signed request from the cloud. What comes back is counts and sums only; see [what-leaves-your-server.md](what-leaves-your-server.md).

## Reading results

The experiment page shows, per goal and variant: units, conversions, rate (or value per unit), lift over control with a 95% interval, P(beat control), P(best) and risk, plus a state:

- **insufficient:** below the minimum visitors or conversions; it estimates how many more visitors per arm it needs.
- **running:** enough data to compare, no decision yet.
- **winner / loser:** P(beat control) ≥ 99% with expected loss ≤ 1% (winner), or P(beat control) ≤ 1% (loser).

Arms with no visitors stay out of the comparison. **Recompute** runs an aggregate now (at most once a minute per site).
