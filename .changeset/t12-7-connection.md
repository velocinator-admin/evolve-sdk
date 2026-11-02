---
"next-evolve": patch
---

Dynamic mode with `cacheComponents`: `<Optimizable>` awaits `connection()` before it reads the bundle, so Next no longer reports "encountered the unstable value `Date.now()` while prerendering" once an experiment runs. Static-mode pages and control renders don't call it and stay cacheable. Docs: the quickstart's Postgres port is 54320.
