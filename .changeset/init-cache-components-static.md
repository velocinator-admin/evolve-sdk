---
"next-evolve": patch
---

`init` with `cacheComponents: true` sets up static mode (the default) instead of switching to dynamic. It writes each moved page the way Next allows there: the default export is a `"use cache"` page with `cacheLife("hours")` that renders the `withEvolve` page, with no `revalidate` or `dynamicParams` exports. A page that reads `searchParams`, `cookies()` or `headers()`, a `page.ts` file and a page with its own segment config stay in dynamic mode, and init says why. `--mode dynamic` works as before. `--cdn-routing` with `cacheComponents` is refused for now.
