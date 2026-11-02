---
"next-evolve": patch
---

Docs ship with the package (README quickstart + `docs/`). Works with new `create-next-app` projects: with `cacheComponents: true`, `init` uses dynamic mode (static mode's segment config is rejected there) and says to wrap `<Optimizable>` in `<Suspense>`; `init` adds `<EvolveScript />` to a one-line `<body>`; region registration no longer calls `after()` during render (Next flagged its clock read under `cacheComponents`); the beacon looks for regions that stream in after the first scan; a new site's "no bundle" is logged as such instead of as a failed fetch; `init` no longer prints `push` output.
