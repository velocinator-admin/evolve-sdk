# API reference

The package has six entry points. Server-only ones import `server-only`, so importing them from a client component fails the build.

| Import                        | Where it runs                                             |
| ----------------------------- | --------------------------------------------------------- |
| `next-evolve`                 | Server components: regions and static-mode pages          |
| `next-evolve/config`          | Anywhere: `defineConfig`, `defineGoals`                   |
| `next-evolve/server`          | Server: route handlers, `evolve.track`, `evolve.identify` |
| `next-evolve/client`          | Browser: `<EvolveScript />`, `track`, `identify`          |
| `next-evolve/proxy`           | `proxy.ts` / `middleware.ts` (Node runtime)               |
| `next-evolve/instrumentation` | `instrumentation.ts`                                      |

## `next-evolve`

### `optimizable(Component, schema)`

```ts
function optimizable<P, S extends z.ZodObject>(
  component: ComponentType<P>,
  schema: S,
): OptimizableComponent<P, S>;
```

Marks a component as optimizable. `schema` is a Zod 4 object listing the props Evolve may change. Every schema key must be a prop the component accepts, with a compatible type, or it fails to compile. Constraints (`min`, `max`, `enum`, `url()`…) become the dashboard's form validation. `.meta({ label: "Headline" })` labels a field. Returns a thin wrapper; your component isn't modified.

**Locking a prop.** `.meta({ locked: true })` keeps a field at the value in your code: the dashboard refuses to change it ("locked in code"), and AI suggestions never see or change it (it is left out of the schema the model gets, and every proposal is checked again after merging). Use it for legal copy, prices, product names or anything you don't want tested:

```ts
const heroSchema = z.object({
  title: z.string().min(3).max(60).meta({ label: "Headline" }),
  disclaimer: z.string().meta({ label: "Disclaimer", locked: true }),
});
```

The AI also never writes links or images: `url()` fields and string fields named like links (`href`, `url`, `src`, `link`, `path`, `image`, `img`, `to`, or ending in `Href`, `Url`, `Src`, `Link`, `Path`, `Image`…) are left out of its schema, and a proposal whose copy contains a link, an e-mail address or a domain is rejected (unless control's copy already shows it). If a region has nothing left to edit, "Suggest variants" is disabled with the reason.

**Render props as text.** Variant props (written by people or the AI) arrive as plain strings and React escapes them when you render them as children or attributes. Don't pass an optimizable prop into `dangerouslySetInnerHTML` (or any other raw-HTML sink such as `innerHTML` in an effect): that would turn a variant's copy into markup on your page.

### `<Optimizable id component props />`

```tsx
<Optimizable id="hero" component={Hero} props={{ title: "Ship faster", cta: "Start free" }} />;
```

| Prop        |                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Region id, unique per site: `/^[a-z0-9][a-z0-9-]{0,39}$/`                                                                                                                                         |
| `component` | A component returned by `optimizable()`                                                                                                                                                           |
| `props`     | Control props. Fields with schema defaults are optional; non-schema props pass through to every variant                                                                                           |
| `vars`      | Optional (0.9+). Per-page values for `{var}` placeholders in variant copy, e.g. CMS data: `vars={{ fullName: person.fullName }}`. Route params (`{name}` on `/:name(…)`) are available without it |

A server component (async). It renders the variant the proxy chose, or control. It never throws because of Evolve: a missing bundle, an unknown variant or props that fail the schema all render control. In development it warns once when it renders without Evolve context (the page isn't under `app/[evolve]/` and the route isn't a dynamic-mode route in `evolve.config.ts`).

On a page's first render in a process it registers the region (id, JSON Schema of the props, control props, path, and since 0.9 the names of the vars it offers: route params plus `vars` keys) with the cloud, in the background. Var values never leave your server.

**Templated pages (0.9+).** Variant string props may contain `{var}` placeholders, filled per page: `"Hire {name} today"` on `/:name([A-Z][A-Za-z]*-[A-Za-z-]+)` renders "Hire Christopher-G today" on `/Christopher-G`. A variant that uses a var the page doesn't provide (or a value over 500 characters) renders control for that view, marked not counted. Values are inserted as text (React escapes them), and the result must still pass the schema.

With `cacheComponents: true`, wrap it in `<Suspense>`.

### `withEvolve(Page, { path })`

Wraps a static-mode page under `app/[evolve]/<route>/page.tsx`. Reads the variant code from the `[evolve]` segment (a malformed code is a 404) and makes it available to every `<Optimizable>` on the page. `path` is the public path (`"/"`, `"/pricing"`). `init` writes this for you.

### `evolveStaticParams()`

`generateStaticParams` for static-mode pages. Prerenders control only (`ev_0`), so builds need no network. Variants render on first request and are then cached.

### `evolveMetadata(path, base?)`

`generateMetadata` for static-mode pages. `base` is your metadata object or function. Sets `alternates.canonical` to `path` and `robots: { index: false, follow: true }` on variant renders.

A static-mode page as `init` writes it:

```tsx
export const dynamicParams = true;
export const generateStaticParams = evolveStaticParams;
export const revalidate = 3600;
export const generateMetadata = evolveMetadata("/", { title: "Acme" });
export default withEvolve(Home, { path: "/" });
```

### `getOptimizableMeta(component)`

Returns `{ schema, jsonSchema, schemaHash, keys }` for an optimizable component, or `null`. For tooling and tests.

## `next-evolve/config`

### `defineConfig(config)`

```ts
import { defineConfig } from "next-evolve/config";

export default defineConfig({
  routes: { "/": { mode: "static" }, "/pricing": { mode: "dynamic" } },
});
```

Validates and returns the config; throws on mistakes. All options are in [configuration.md](configuration.md).

### `defineGoals(goals)`

Validates and returns the goals. See [goals-and-attribution.md](goals-and-attribution.md).

### `evolveRewrites(config)` and `evolveMatcher(config)` (since 0.6)

For `cdnRouting` ([configuration.md](configuration.md#cdn-routing-cdnrouting)). `evolveRewrites(config)` returns the `beforeFiles` rewrites for `next.config`: a request for a static-mode route carrying its route cookie (a well-formed code, no preview) goes to the cached variant page. `evolveMatcher(config)` returns the proxy matcher for `proxy.ts`, which Next needs as a literal, so `init --cdn-routing` writes it out and `doctor` compares it. Without `cdnRouting`, `evolveRewrites` returns `[]` and `evolveMatcher` the plain list (`[...routes, "/(ev_.*)"]`). `cdnCookieName(path)` gives a route's cookie name (`evolve_r_<hash>`).

## `next-evolve/server`

### `createEvolveHandler({ config, goals })`

```ts
// app/api/evolve/[...evolve]/route.ts
import { createEvolveHandler } from "next-evolve/server";
import evolveConfig from "@/evolve.config";
import goals from "@/evolve.goals";

export const { GET, POST } = createEvolveHandler({ config: evolveConfig, goals });
export const maxDuration = 60;
```

Serves the routes under `/api/evolve/` (see [HTTP routes](#http-routes)). Keep `maxDuration = 60` so aggregation fits on serverless hosts.

### `evolve.track(name, options?)`

```ts
import { evolve } from "next-evolve/server";

await evolve.track("project_created", { userId: user.id });
```

Writes an event to your database. Never throws. Options:

| Option      | Default                                             |                                                                                     |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `userId`    | —                                                   | Your user id. Links the event to experiments through `identify`                     |
| `anonId`    | the visitor's `evolve_id` cookie (inside a request) | The visitor id                                                                      |
| `value`     | —                                                   | A number, used by goals without their own `value`                                   |
| `props`     | —                                                   | Any JSON object up to 2 KB (larger props are dropped, the event is kept)            |
| `source`    | `"server"`                                          | A label goals can filter on, e.g. `"stripe"`                                        |
| `ts`        | now                                                 | Event time (`Date`, ISO string or ms)                                               |
| `dedupeKey` | —                                                   | Stored once; a second event with the same key is ignored (use the webhook event id) |

### `evolve.identify(userId, { anonId? })`

Links the visitor (the `evolve_id` cookie, or `anonId`) to your user id, so events with that `userId` (on other devices, or from your server) count for that visitor's experiments. The first link for a visitor wins. Never throws. Call it after sign-up or sign-in.

## `next-evolve/client`

### `<EvolveScript />`

Put it once in the root layout's `<body>`. About 1.6 KB gzipped, no dependencies, not needed to show a variant. On every route it sends a page view and one exposure per counted region; on clicks (forms: on submit) of elements with `data-evolve-goal="<event>"` it sends that event. It batches every 2 seconds and on page hide, to `/api/evolve/collect` on your own origin. It does nothing under automation (`navigator.webdriver`).

### `track(name, props?)` and `identify(userId)`

Browser versions of the server calls. Prefer `evolve.identify()` on the server.

## `next-evolve/proxy`

### `createEvolveProxy(config, { buildBundle })`

```ts
// proxy.ts (Next 16)
import { createEvolveProxy } from "next-evolve/proxy";
import buildBundle from "./.evolve/bundle.generated";
import evolveConfig from "./evolve.config";

export const proxy = createEvolveProxy(evolveConfig, { buildBundle });
export const config = { matcher: ["/", "/pricing", "/(ev_.*)"] };
```

On Next 15.5 use `middleware.ts`, `export const middleware = …`, and add `runtime: "nodejs"` to `config`. The matcher must cover every route in `evolve.config.ts` plus `/(ev_.*)`.

### `applyEvolve(config, req, event, { buildBundle })`

For an existing proxy. Returns a response for Evolve routes and `/ev_*` paths, or `null` for everything else:

```ts
import { applyEvolve, evolveReady } from "next-evolve/proxy";

export async function proxy(req: NextRequest, event: NextFetchEvent) {
  await evolveReady(evolveConfig); // only matters with Vercel Global Config
  const evolved = applyEvolve(evolveConfig, req, event, { buildBundle });
  if (evolved) return evolved;
  // …your own logic
}
```

### `evolveReady(config)`

With Vercel Global Config, a fresh instance's first request waits up to 20 ms for one read of the store. Returns `null` when there's nothing to wait for.

## `next-evolve/instrumentation`

### `registerEvolve({ config, goals })`

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ registerEvolve }, { default: config }, { default: goals }] = await Promise.all([
      import("next-evolve/instrumentation"),
      import("./evolve.config"),
      import("./evolve.goals"),
    ]);
    await registerEvolve({ config, goals });
  }
}
```

Registers your goals for the process (goal `value` functions need this), sends the manifest (routes, goals, versions, app URL) to the cloud once per process and, on long-running Node, polls the bundle in the background and keeps it on disk. Never throws.

## CLI

Run with `npx next-evolve <command>`. Reads `.env.local` and `.env` (never overriding variables already set).

| Command                                                                                                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [--key] [--webhook-secret] [--db <url>] [--app-url <url>] [--mode static\|dynamic] [--routes "/ /pricing"] [--cdn-routing] [--yes] [--dry-run]` | Sets Evolve up in this app (see the README). Re-running changes nothing that's already done. `--cdn-routing` (static mode only) turns on `cdnRouting` and writes the `evolveMatcher()` literal into `proxy.ts` and `evolveRewrites()` into `next.config` (it prints instructions for a `next.config` it can't edit safely, e.g. one with its own `rewrites`). `--dry-run` prints the diff and writes, installs, migrates and sends nothing. `--yes` answers every prompt with the default. Without `--db` it offers `DATABASE_URL` / `POSTGRES_URL` if set |
| `migrate [--url <postgres-url>]`                                                                                                                      | Creates or updates the `evolve` schema (default `$EVOLVE_DATABASE_URL`). Run it on every deploy, or after upgrading `next-evolve`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pull`                                                                                                                                                | Writes the verified bundle to `.evolve/bundle.generated.ts`. Runs as `prebuild`. Never fails the build: without a key or the cloud it keeps the previous file or writes an empty one                                                                                                                                                                                                                                                                                                                                                                       |
| `push`                                                                                                                                                | Sends the manifest (routes and goals) now. It's also sent when the app starts                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `connect [--test] [--app-url <url>]`                                                                                                                  | Checks the key; `--app-url` registers where the app lives; `--test` asks the cloud to call your sync route (ping) and aggregate route (signed dry run)                                                                                                                                                                                                                                                                                                                                                                                                     |
| `doctor`                                                                                                                                              | Checks the setup: Next.js version, env vars, key, database (reachable, migrated), bundle (valid, more than 7 days from expiry, build copy present), proxy matcher, pages, `<EvolveScript />`, cloud → app reachability, CDN. Exits 1 when a check fails                                                                                                                                                                                                                                                                                                    |
| `wrap [route] [--component <Name,…>] [--yes] [--dry-run] [--build]`                                                                                   | Finds the components a page renders, generates a Zod schema from their TypeScript props (a sibling `<file>.evolve.ts` with an `optimizable()` export) and replaces the usage with `<Optimizable id>`. Shows the diff first; runs `tsc` (and `next build` with `--build`) and restores every file if it fails. See [wrap](wrap.md)                                                                                                                                                                                                                          |
| `aggregate [--upload]`                                                                                                                                | Asks the cloud what to aggregate, runs it on your local database and prints the result; `--upload` sends it to the cloud. For local development, where the cloud can't reach your app                                                                                                                                                                                                                                                                                                                                                                      |

## HTTP routes

All served by `createEvolveHandler` under `/api/evolve/`.

| Route                        | Caller                                                   | Auth                                                                   | Answers                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/evolve/collect`   | `<EvolveScript />`                                       | Same origin only                                                       | `204`. Batches over 32 KB or 50 events, or cross-origin, are refused. Bot user agents, preview sessions and visitors without an `evolve_id` cookie are dropped |
| `POST /api/evolve/track`     | Your servers, Segment, a CRM                             | `Authorization: Bearer $EVOLVE_TRACK_SECRET`                           | `{ accepted: n }`; `404` when `EVOLVE_TRACK_SECRET` isn't set; `401` wrong bearer; `400` bad body                                                              |
| `POST /api/evolve/sync`      | Evolve Cloud (bundle changed, or a connection-test ping) | HMAC with `EVOLVE_WEBHOOK_SECRET`, 5-minute clock window, replay check | `202`, then fetches the bundle                                                                                                                                 |
| `POST /api/evolve/aggregate` | Evolve Cloud                                             | HMAC with `EVOLVE_WEBHOOK_SECRET`; the response is signed too          | Counts and sums. `503` when the database isn't configured or is down; `409` for a replay; `429` while another aggregation runs                                 |
| `GET /api/evolve/health`     | You, monitoring                                          | None                                                                   | `{ ok, protocol, db }` (`db`: whether a database URL is set)                                                                                                   |

`/api/evolve/track` body:

```json
{
  "events": [
    {
      "name": "subscription_started",
      "userId": "u_123",
      "value": 49,
      "props": { "plan": "pro" },
      "source": "segment",
      "ts": "2026-11-01T12:00:00Z",
      "dedupeKey": "evt_1"
    }
  ]
}
```

At most 500 events per call. `name` is required; every other field is optional (as in `evolve.track`). The default `source` is `"webhook"`. The events are written before the response, so a sender that retries on failure won't lose any.
