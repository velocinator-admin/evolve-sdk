---
"next-evolve": minor
---

Proxy overhead on Vercel (docs/perf/proxy-overhead.md):

- New opt-in `cdnRouting` in `evolve.config` (static-mode routes): after the proxy routes a visitor, a short-lived per-route cookie (`evolve_r_<hash>`, default lifetime = the poll interval) lets a `next.config` rewrite serve the cached variant without invoking the proxy. Wire it with `evolveRewrites(config)` in `next.config` and the literal from `evolveMatcher(config)` in `proxy.ts`. Off by default; nothing changes without it.
