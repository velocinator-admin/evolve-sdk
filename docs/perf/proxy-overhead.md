# Proxy overhead on Vercel (2026-11-02)

On `https://4dfit.app` the Evolve proxy measured +19 ms p50 / +13 ms p95 TTFB (`/` through the proxy vs `/privacy` without it, both CDN HITs; T12.4), against an in-proxy `Server-Timing` of 0.12 ms and a 5 ms budget. This note finds where that time goes and what can be done about it.

**Status (2026-11-02, updated 2026-11-05):**

| | where |
|---|---|
| `registerEvolve` no longer awaits the manifest push | **shipped in `next-evolve` 0.5.1** |
| `next-evolve/config` loads under `require()` (`default` export condition), so `next.config.ts` can import it | **shipped in `next-evolve` 0.5.1** (the build's `check-dist` requires it) |
| Budget restated for Vercel (≈ +20 ms on a first view, ≈ 0 on CDN-routed repeat views; 5 ms still applies to in-proxy time and `next start`) | evolve-cloud `docs/roadmap/phase-1-technical-spec.md` §6.6, and [phase-1.md](phase-1.md) |
| Opt-in `cdnRouting` (repeat views skip the proxy) | **shipped in `next-evolve` 0.6.0** (2026-11-05, T19.5a): forged-cookie protection, `init --cdn-routing`, `doctor`, fixture e2e, docs; re-measured on Vercel below |

**Short version:** the cost is Vercel invoking a proxy function at all. A no-op `proxy.ts` that only returns `NextResponse.next()` costs the same +18 ms as Evolve; Evolve's own code adds ~1 ms on top. Edge-runtime middleware costs the same. Nothing on the warm request path makes a network call. The only way under the budget is not to invoke the proxy: `cdnRouting` (opt-in since 0.6.0) serves repeat views from the CDN with **+0 ms** (measured with the released code), and first views keep the ~+18–20 ms platform cost.

## Method

Throwaway Vercel projects on team Velocinator (Hobby, function region iad1, Fluid Compute, Next 16.2.10 like 4dfit), all deleted afterwards:

| project | what it serves |
|---|---|
| `evolve-perf-bench-proxy` | `proxy.ts` with matcher `/noop` (returns `NextResponse.next()`), `/rw` (fixed `NextResponse.rewrite`), `/evolve` (`createEvolveProxy`, npm `next-evolve` 0.4.1, a valid bundle signed with the fake-cloud test key, running A/B), `/ck` (cookie-gated matcher, see below); `/plain` is outside the matcher |
| `evolve-perf-bench-edge` | the same paths through `middleware.ts` (Edge runtime; deprecated name in Next 16, still built) |
| `evolve-perf-bench-cdn` | `next-evolve` from this branch with `cdnRouting: { maxAgeSeconds: 600 }`, `evolveRewrites()` in `next.config.ts`, `evolveMatcher()` literal in `proxy.ts` |
| `evolve-perf-bench-instr` | the proxy bench plus `instrumentation.ts` calling `registerEvolve` (as `init` writes it), with headers reporting whether `register()` ran and in which region the proxy instance lives |
| `evolve-perf-probe-fra1`, `evolve-perf-fakecloud` | a measuring function in fra1, and a stand-in `/v1/manifest` so nothing touched the production cloud |

Every page is static or ISR and was a CDN `HIT` in every counted sample. Sampler: `apps/fixture/scripts/ttfb-alternate.mjs` (round-robin over all targets with the order rotated each round, keep-alive, 150 ms between requests so Vercel never challenged; non-200 and `x-vercel-mitigated` dropped, none were). Measured from a laptop in Nashville (nearest POP iad1), and from Globalping probes in Europe and Asia (single-shot requests, `firstByte` excludes DNS/TCP/TLS).

## Results

### Nashville, run 1: 200 alternating rounds (1,800 requests)

TTFB in ms (includes ~100 ms of last-mile latency; only the deltas matter).

| variant | p50 | p95 | added p50 | added p95 | in-proxy p50 |
|---|---|---|---|---|---|
| (a) no proxy (`/plain`) | 101.9 | 153.4 | — | — | — |
| (b) no-op proxy, `NextResponse.next()` | 119.7 | 179.6 | **+17.8** | +26.2 | — |
| (b') proxy, fixed `NextResponse.rewrite` | 120.8 | 158.2 | +18.9 | +4.8 | — |
| (c) Evolve proxy 0.4.1, returning visitor¹ | 121.1 | 163.2 | +19.3 | +9.8 | 0.35 |
| (c) Evolve proxy 0.4.1, new visitor¹ | 122.6 | 166.3 | +20.7 | +12.9 | 0.35 |
| (d) cookie-gated matcher, proxy skipped (`/ck` + cookie) | 101.9 | 147.4 | **+0.1** | −6.0 | — |
| (d) Edge middleware deploy, page outside matcher | 103.1 | 142.8 | +1.2 | −10.7 | — |
| (d) Edge middleware, fixed rewrite | 120.1 | 158.4 | +18.3 | +5.0 | — |
| (d) Edge middleware, `NextResponse.next()` | 122.1 | 159.1 | +20.3 | +5.7 | — |

¹ In run 1 the hand-made bench bundle was rejected (`invalid_payload`), so `/evolve` ran the whole proxy but served control without assigning. Run 2 repeats it with a valid bundle.

### Nashville, run 2: 250 alternating rounds, valid bundle, prototype included

A better network day (~50 ms base). The bundle is valid: new visitors get `evolve_id`, `evolve_a` (and, with `cdnRouting`, the route cookie); returning visitors are served their variant (`/ev_k3j9x2-c1d2e3`, on-demand ISR, `HIT`).

| variant | p50 | p95 | added p50 | added p95 | in-proxy p50 |
|---|---|---|---|---|---|
| (a) no proxy (`/plain`) | 51.7 | 84.4 | — | — | — |
| (b) no-op proxy, `NextResponse.next()` | 74.9 | 107.9 | **+23.2** | +23.4 | — |
| (c) Evolve proxy 0.4.1, new visitor | 74.9 | 108.4 | +23.3 | +24.0 | 0.27 |
| (c) Evolve proxy 0.4.1, returning visitor (variant) | 73.1 | 121.4 | +21.4 | +37.0 | 0.11 |
| prototype `cdnRouting`, first view | 68.6 | 105.5 | +16.9 | +21.0 | 0.34 |
| **prototype `cdnRouting`, repeat view (variant)** | **50.5** | **78.2** | **−1.1** | **−6.2** | not invoked |

Evolve is indistinguishable from a no-op proxy (±2 ms; in-proxy 0.1–0.3 ms). The `cdnRouting` repeat view matches the no-proxy page, and its responses carry no `Server-Timing` or `Set-Cookie`: the proxy didn't run.

### Re-measure with the released code: `next-evolve` 0.6.0 (2026-11-05)

Throwaway project `evolve-perf-bench-060` (team Velocinator, Hobby, Next 16.2.10, npm `next-evolve@0.6.0` with `cdnRouting: true`, default `maxAgeSeconds` = 60; `evolve.config`, `evolveRewrites()` in `next.config.ts` and the `evolveMatcher()` literal in `proxy.ts`; a fake-cloud-signed bundle with all traffic on B, `EVOLVE_CLOUD_URL` pointing nowhere, so no production cloud was touched), deleted after the run. Same sampler, 250 rounds × 4 targets, 150 ms gap, from Nashville. Every sample a CDN `HIT`, none dropped.

| variant | p50 | p95 | added p50 | added p95 | in-proxy p50 |
|---|---|---|---|---|---|
| (a) no proxy (`/plain`) | 46.1 | 70.6 | — | — | — |
| first view (proxy, new visitor) | 65.6 | 111.7 | **+19.4** | +41.2 | 0.32 |
| returning visitor, route cookie expired (proxy) | 64.7 | 102.4 | +18.6 | +31.8 | 0.19 |
| **repeat view (`cdnRouting`, proxy not invoked)** | **45.4** | **80.9** | **−0.8** | +10.3 | not invoked |

Checked on the deployment: the first view sets `evolve_r_1kbj9e7=ev_k3j9x2-c1d2e3; Max-Age=60` with `evolve_id`/`evolve_a`; the repeat view has no `Server-Timing` and no `Set-Cookie` (`x-matched-path: /[evolve]/evolve`, `HIT`); a forged well-formed code is served without the proxy (control); a malformed cookie runs the proxy, which re-issues the cookie; `/ev_*` directly is still a 404. This matches the prototype's run 2 (repeat −1.1 ms, first view +16.9 ms).

### Europe and Asia (Globalping, 7 probes: fra1 ×3, arn1, sin1, hnd1 ×2 POPs; 2 rounds)

Single-shot requests are noisy, and the first round hit cold proxy instances: 0.3–1.4 s for every proxied target, versus 0.2–0.6 s for the plain page (also cold caches). Median `firstByte` of the warm second round:

| variant | firstByte p50 (ms) |
|---|---|
| (a) no proxy | 27 |
| (b) no-op proxy | 64 |
| (c) Evolve proxy, new visitor | 93 |
| `cdnRouting`, first view | 131 |
| **`cdnRouting`, repeat view** | **28** |

An earlier Europe-only run (6 probes, 2 rounds) gave +21 ms (fixed rewrite) to +36 ms (no-op) over the plain page, and +74 ms for Edge middleware. That's not a transatlantic round trip (fra1↔iad1 ≈ 90 ms), and it matches the deployment facts below.

## Where the proxy runs (checked, not assumed)

- **Next 16's Node `proxy.ts` on Vercel is a Lambda deployed to 8 regions:** `vercel inspect --json` shows `_middleware` `deployedTo: [bom1, fra1, gru1, iad1, lhr1, sfo1, sin1, syd1]`, the same on 4dfit and the benches. The bench instance reported `VERCEL_REGION` fra1 for German probes, sin1 for Tokyo and syd1 for Sydney. So the hypothesis "edge POP → iad1 → back" is **refuted**: it isn't pinned to the function region. Visitors whose POP is far from those 8 regions (hnd1 → sin1, for example) do pay that extra distance.
- **"Edge" middleware is the same thing now:** `middleware.ts` (Edge runtime) deploys as a Lambda with an edge runtime layer, in the same 8 regions. That's why it costs the same as Node. Next 16 `proxy.ts` is Node-only; switching runtimes buys nothing.
- **4dfit's `x-vercel-id: fra1::iad1::…` is not a proxy hop.** It shows up for any on-demand ISR page (`x-matched-path: /[evolve]/…`, a variant that wasn't prerendered at build), proxy or not. The bench's CDN-routed repeat view had it without invoking the proxy. Warm EU requests to 4dfit `/` came back in 33–44 ms firstByte, which is impossible with an iad1 round trip.
- **Cold starts are the bigger cost on a low-traffic site:** a cold proxy instance answered in 0.6–1.1 s (4dfit from Europe: ~1 s on the first request, 33–44 ms on the next, in-proxy 13–20 ms cold vs 0.15 ms warm). 200-sample runs keep instances warm, so they understate what a site with little traffic sees. Any proxy has this; it's one more reason to skip the proxy when it isn't needed.

## The request path, every await and I/O (next-evolve 0.4.1)

`createEvolveProxy()(req)` → `evolveReady()` → `applyEvolve()`:

| step | blocking? | I/O |
|---|---|---|
| `evolveReady` → `coldStart(store)` | only with Global Config (`EVOLVE_GLOBAL_CONFIG`): the instance's first request waits ≤ 20 ms (`COLD_READ_CAP_MS`) for one Global Config read | network (Global Config, not Evolve's cloud); 4dfit doesn't use it |
| `resolveConfig` | no (WeakMap-cached) | none |
| `getBundleStore` | no; the first call verifies the build bundle's Ed25519 signature once per instance | none (disk cache only off Vercel) |
| `store.peek(waitUntil)` | no: when the poll is due (60 s ± 10%) it starts `GET /v1/bundle` and hands the promise to `waitUntil`; the response doesn't wait | background network to the cloud |
| bot check, cookie parse, `assign`, `encodeCode`, `newAnonId` | no | none |
| `verifyPreview` | only with a preview token; synchronous signature check | none |
| `NextResponse.rewrite` / `.next` | no | none |

No `after()`, no logging on the happy path (`logRateLimited` only on errors), no DB driver (the proxy bundle never imports it; `check-proxy-imports`). **The owner's position holds for the warm request path on Vercel: no network call to Evolve, no blocking I/O.** Two exceptions found:

1. **`registerEvolve` awaited the manifest push** (`pushToCloud("/v1/manifest")`, 3 s timeout). Next awaits `register()` before an instance serves its first request (`ensureInstrumentationRegistered()` in `next/dist/server/web/adapter.js`, and the Node server). So every cold start of a page function (dynamic-mode routes, ISR misses and revalidations) and of `next start`/Docker waited for a round trip to Evolve's cloud, up to 3 s if the cloud was slow or unreachable. On Vercel the separate proxy Lambda does **not** run `register()`: the bench's instrumentation marker never appeared in the proxy, while on `next start` it ran (25 ms) before the first proxied request. **Fixed in 0.5.1:** the push runs in the background.
2. Global Config's ≤ 20 ms cold read (by design, spec §7.8, opt-in).

## Root cause

The 13–19 ms is the platform cost of invoking any proxy function on Vercel (routing the request into a Lambda in the nearest of 8 regions and back before the cache lookup), not Evolve's code (0.1–0.5 ms in-proxy, ~1–2 ms end to end over a no-op proxy) and not a network call. It can't be tuned away inside the proxy, and Edge runtime, Bun or a smaller bundle don't remove the invocation. A tighter matcher already applies (4dfit's matcher is `/` and `/(ev_.*)`); what helps is a matcher that skips requests that don't need the proxy.

## `cdnRouting` (prototyped on `perf/proxy-overhead`, shipped in 0.6.0)

This section describes the prototype; 0.6.0 ships it with the follow-ups listed at the end (now done). User docs: `packages/next-evolve/docs/configuration.md#cdn-routing-cdnrouting`.

**`cdnRouting` (opt-in, static-mode routes).** After the proxy routes a visitor, it also sets `evolve_r_<hash(route)>` = the variant code (HttpOnly, SameSite=Lax, Max-Age = `cdnRouting.maxAgeSeconds`, default the poll interval, 60 s in production). Two pieces of config keyed on that cookie:

```ts
// next.config.ts
import { evolveRewrites } from "next-evolve/config";
import evolveConfig from "./evolve.config";
export default {
  async rewrites() {
    return { beforeFiles: evolveRewrites(evolveConfig), afterFiles: [], fallback: [] };
  },
};

// proxy.ts: Next needs a literal; this is evolveMatcher(evolveConfig) for routes { "/": static }
export const config = {
  matcher: [
    { source: "/", missing: [{ type: "cookie", key: "evolve_r_<hash>" }] },
    { source: "/", has: [{ type: "cookie", key: "evolve_pv" }] },
    { source: "/", has: [{ type: "query", key: "evolve_preview" }] },
    "/(ev_.*)",
  ],
};
```

A request carrying the cookie (and no preview) never invokes the proxy: Vercel applies the matcher's `missing` and the `beforeFiles` rewrite (`/` → `/<code>`, value checked against the code grammar) at the CDN. Measured: repeat views at the no-proxy TTFB (run 2), and the proxy really isn't invoked (no `Server-Timing`, no `Set-Cookie` on those responses).

Properties:

- **Backward compatible:** off by default. Without `cdnRouting`, `evolveRewrites` is `[]`, `evolveMatcher` is `init`'s current list, and the proxy behaves byte-for-byte as before (tests).
- **Staleness is bounded by the cookie's lifetime.** A pause, completion or auto-rollback reaches a returning visitor within `maxAgeSeconds`. The default (= poll interval) keeps spec §7.9's convergence bound ("one poll interval plus the triggering request"); raise it to save more invocations at the cost of slower rollbacks. Sticky assignment itself still lives in `evolve_a` (365 d), so the visitor keeps their arm when the proxy runs again.
- **No cookie when nothing runs** on the route, for bots, without consent, for previews, or on dynamic-mode routes (those need the proxy's header).
- **Previews** always go through the proxy (matcher `has` + rewrite `missing` on `evolve_pv` / `?evolve_preview`).
- **Risk: a visitor can forge the cookie** and pick any code. Today that's possible through `evolve_a` too, but limited to the bundle's arms. A forged route cookie can also name a code for a completed experiment, or an arbitrary well-formed code, which renders control (`data-evolve-x`, not counted). The bigger worry: each distinct forged code is a new ISR render, and an unknown variant triggers `getRenderBundle({ fresh: true })`, so a script could force renders and bundle refetches. Before shipping, rate-limit the fresh refetch per instance (collect already does ≤ 1 per 5 s) and consider `dynamicParams` limits. Today the proxy's 404 on `/ev_*` blocks this path.
- `next-evolve/config` gains a `default` export condition (**shipped in 0.5.1**): Next compiles `next.config.ts` to CommonJS, and the package was `import`-only (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Node ≥ 22.12 (already required) loads ESM through `require`.

**Expected TTFB:** repeat views of a CDN-routed page +0 ms (within noise, run 2); first views (and the first view after the cookie expires) about +18–20 ms on Vercel, the floor for any proxy. For a single-page funnel like 4dfit (`/` only, mostly first-time visitors), most traffic is first views, so the site-wide average barely moves. Navigation back to `/` within a session, and repeat visits within `maxAgeSeconds`, are where it pays.

**Also on the branch, shipped in 0.5.1:** `registerEvolve` no longer awaits the manifest push (removes up to 3 s from cold starts of page functions and `next start`).

**Follow-ups, done in 0.6.0 (T19.5a):** `init --cdn-routing` writes `cdnRouting`, the matcher literal and the `next.config` rewrites; `doctor` checks the literal equals `evolveMatcher()` and `next.config` calls `evolveRewrites()`; the render-side fresh refetch is limited to 1 per 5 s per instance (forged codes render control, uncounted); the matcher's `missing` carries the code pattern, so a malformed cookie runs the proxy instead of 404ing; fixture e2e `apps/fixture/e2e/cdn.spec.ts`; README/docs; the Vercel re-measure above. Each distinct forged code still costs one ISR render (like any unknown `[slug]`), affecting only the forger.

## Recommendation

1. **Restate the budget for Vercel** (done: spec §6.6, phase-1.md): "≤ 5 ms added TTFB" isn't reachable on Vercel for any request that runs a proxy; a no-op proxy measures ~+18 ms. Keep 5 ms for in-proxy time (0.1–0.5 ms, met) and for self-hosted `next start` (0.45–0.59 ms, met, phase-1.md). For Vercel, state "+≤ 20 ms on a first view, +0 on CDN-routed repeat views".
2. **Ship the `registerEvolve` fix** (done, 0.5.1) regardless (no behaviour change except that cold starts stop waiting on the cloud).
3. **Ship `cdnRouting` as opt-in** (done, 0.6.0, T19.5a); default `maxAgeSeconds` = poll interval; the staleness trade-off is in the docs. It stays off by default.
4. Don't pursue Edge runtime, Bun or bundle-size work for this: none of them remove the invocation (measured for Edge).

## Reproduce

```bash
# targets.json: [{ "name": "baseline", "url": "https://…/plain" }, { "name": "proxy", "url": "https://…/", "cookie": "…" }]
node apps/fixture/scripts/ttfb-alternate.mjs targets.json 200 150
```
