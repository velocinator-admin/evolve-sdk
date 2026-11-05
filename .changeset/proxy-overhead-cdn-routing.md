---
"next-evolve": minor
---

Opt-in `cdnRouting` (docs/configuration.md#cdn-routing-cdnrouting): on Vercel, repeat views of static-mode routes skip the proxy (measured +0 ms TTFB instead of ~+20 ms).

- After the proxy routes a visitor it sets a short-lived per-route cookie (`evolve_r_<hash>`, `maxAgeSeconds` = the poll interval by default) holding the variant code; `evolveRewrites(config)` in `next.config` serves the cached variant from it, and the `evolveMatcher(config)` literal in `proxy.ts` skips the proxy for it. Previews, bots, dynamic routes and malformed cookies always run the proxy. A pause or rollback reaches a returning visitor within `maxAgeSeconds`.
- Forged codes are harmless: a code the bundle doesn't know renders control (uncounted), and the render-side fresh bundle pull is limited to one per 5 s per instance.
- `next-evolve init --cdn-routing` writes the config flag, the matcher literal and the `next.config` rewrites; `next-evolve doctor` fails when the literal doesn't match `evolveMatcher(config)` or `next.config` doesn't call `evolveRewrites()`.
- Off by default: without `cdnRouting`, `evolveRewrites` is `[]`, `evolveMatcher` is the plain list and the proxy is unchanged.
