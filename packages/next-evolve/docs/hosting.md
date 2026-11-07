# Hosting

Evolve runs wherever Next.js runs a server: the proxy, server rendering and the `/api/evolve/*` route. What changes per host is where the bundle is cached, how a change reaches every instance, and whether a CDN in front of the app could serve one visitor's variant to everyone. For env vars, migrations and the app URL, see [production.md](production.md).

| Host                                | Status                                   | Checked nightly               |
| ----------------------------------- | ---------------------------------------- | ----------------------------- |
| Vercel                              | Supported (recommended: + Global Config) | fixture e2e smoke + benchmark |
| Node server (`next start`)          | Supported                                | full fixture e2e + benchmark  |
| Docker (`output: "standalone"`)     | Supported                                | full fixture e2e + benchmark  |
| Netlify                             | **Beta, unverified**                     | no                            |
| Cloudflare in front of any of these | Supported with the cache rules below     | no                            |
| Cloudflare Workers (OpenNext)       | Not supported yet                        | no                            |

Measured on each host: Evolve's own time in the proxy is well under 1 ms at p95 everywhere; the server time it adds on `next start` and Docker is under 1 ms on static pages (up to ~3 ms on a busy Docker Desktop VM). On Vercel any proxy adds ~20 ms to a first view. Numbers: `docs/perf/host-matrix.md` in the SDK repo.

## Vercel

Nothing to configure: Vercel's CDN caches each rewritten variant path (`/ev_…/pricing`) separately, so variants never mix. Add [Global Config](production.md#vercel--global-config-recommended-on-vercel) so a change reaches every instance within ~5 s, and consider [`cdnRouting`](configuration.md#cdn-routing-cdnrouting) for repeat views.

## Node server (`next start`)

`registerEvolve()` in `instrumentation.ts` polls the cloud every 60 s and keeps the bundle on disk (`os.tmpdir()` or `EVOLVE_CACHE_DIR`), so a restart during a cloud outage still serves the last bundle. With several instances, the sync webhook reaches one at once and the others within one poll interval. Pull mode (`aggregate: { mode: "pull" }`) works here, for servers the cloud can't reach.

Off Vercel the proxy sets `Cache-Control: private, no-store` on tested routes, so a well-behaved shared cache won't store them. If something in front of the app caches anyway, see [CDNs](#cdns-and-reverse-proxies).

## Docker

Use Next's standalone output (`output: "standalone"` in `next.config`; in a monorepo also `outputFileTracingRoot` pointing at the repo root). A minimal image:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile
# The build-time bundle: EVOLVE_SECRET_KEY as a BuildKit secret, never a layer.
RUN --mount=type=secret,id=evolve_secret_key,env=EVOLVE_SECRET_KEY pnpm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
CMD ["node", "server.js"]
```

- `docker build --secret id=evolve_secret_key,env=EVOLVE_SECRET_KEY …` runs `next-evolve pull` (your `prebuild`) with the key, so a fresh container serves the current bundle before its first fetch.
- The standalone image has no CLI: run `npx next-evolve migrate` in your deploy step (or a one-off container from the build stage), not in the runtime image.
- Pass `EVOLVE_SECRET_KEY`, `EVOLVE_WEBHOOK_SECRET`, `EVOLVE_DATABASE_URL` and `EVOLVE_APP_URL` at runtime. Mount a volume at `EVOLVE_CACHE_DIR` if a restart should keep the last bundle through a cloud outage.
- Static-mode pages are cached in the container (`.next/server`, or in memory for `"use cache"` pages), so keep that directory writable by the user the server runs as.
- Everything in [Node server](#node-server-next-start) applies: polling, pull mode, `no-store` on tested routes.

## CDNs and reverse proxies

A tested URL (`/pricing`) serves different HTML to different visitors: the variant comes from the `evolve_a` cookie. A cache that stores the page by URL alone serves whichever variant it saw first to everyone, and your results measure nothing. Off Vercel, Evolve sends `Cache-Control: private, no-store` on tested routes. A cache must respect it, or bypass those routes. (With `cdnRouting` on, repeat views skip the proxy and don't carry that header, so only use `cdnRouting` behind a cache that never stores tested routes, or leave it off.)

`npx next-evolve doctor` requests your live site and names the CDN it sees in the response headers: it warns when Cloudflare or Netlify is in front, and fails when a tested route came out of the CDN's cache.

### Cloudflare

Cloudflare's default caching doesn't store HTML, and it respects `Cache-Control: private, no-store`, so a plain proxied zone is safe. These settings are not:

- **"Cache Everything"** (a Page Rule or a Cache Rule with _Eligible for cache_) on a path that includes a tested route, **together with an Edge TTL that ignores the origin's cache headers** (_Ignore cache-control header and use this TTL_, or _Override origin_).
- **Automatic Platform Optimization (APO)** or any "cache HTML" feature applied to the whole site.

If you use any of these, add a Cache Rule **above** them that bypasses the cache for your tested routes:

1. Cloudflare dashboard → your zone → **Caching → Cache Rules → Create rule**.
2. When incoming requests match: _Custom filter expression_, for example
   `(http.request.uri.path in {"/" "/pricing"}) or starts_with(http.request.uri.path, "/api/evolve/")`
   (list every route in `evolve.config.ts`).
3. Then: **Cache eligibility → Bypass cache**. Deploy, and put the rule first in the list.

Don't try to key the cache on the `evolve_a` cookie instead: custom cache keys that include cookies need an Enterprise plan, and the variant also depends on assignment, which happens in the proxy on the first view.

Two more Cloudflare settings:

- **WAF, Bot Fight Mode, "Under Attack" mode:** Evolve Cloud calls `POST /api/evolve/sync` and `POST /api/evolve/aggregate` from servers without fixed IPs. Add a WAF custom rule that _Skips_ the managed rules and bot checks for `starts_with(http.request.uri.path, "/api/evolve/")`. Those requests are authenticated by their HMAC signature.
- **Rocket Loader** rewrites `<script>` tags, which can break React hydration in general; leave it off for Next.js sites.

Check with `npx next-evolve doctor`, then request a tested route twice and look at `cf-cache-status`: `BYPASS` or `DYNAMIC` is right; `HIT` means one variant is being served to everyone.

### Netlify (beta, unverified)

Netlify runs Next.js through `@netlify/plugin-nextjs` (OpenNext). The proxy becomes an edge function and server rendering a Netlify Function. A local offline `netlify build` of Evolve's test app succeeds (plugin 5.16.6, Next 16.4), but Evolve hasn't verified a deployed site yet: treat it as beta and run `npx next-evolve connect --test` and `doctor` after deploying. What to expect:

- Functions have no lasting disk, so it behaves like Vercel without Global Config: the build-time bundle (keep `"prebuild": "next-evolve pull"`, with `EVOLVE_SECRET_KEY` set for builds), then a 60 s poll per instance on traffic.
- Pull mode needs a long-running server; on Netlify the cloud must reach `/api/evolve/aggregate` (push, the default), so set `EVOLVE_APP_URL` to the site's public URL.
- The plugin should cache each rewritten variant path (`/ev_…`) separately, as on Vercel; this is the part not verified yet. If you add your own `Netlify-CDN-Cache-Control` or cache headers for tested routes, the [CDN rule above](#cdns-and-reverse-proxies) applies, and `doctor` fails if a tested route comes out of Netlify's cache.

Tell us how it goes; Netlify moves to supported once the nightly host matrix runs it.

### Other CDNs (Fastly, CloudFront, nginx, Varnish)

Same rule: don't cache tested routes by URL. Either respect `Cache-Control: private, no-store` (most do by default) or add a pass/bypass rule for the routes in `evolve.config.ts`, and let `/api/evolve/*` through any bot protection.
