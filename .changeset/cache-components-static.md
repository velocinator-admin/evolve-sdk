---
"next-evolve": minor
---

Static mode works with `cacheComponents: true` (HOST-2): mark the `app/[evolve]/…` page's default export `"use cache"` with a `cacheLife`, and each variant code is cached once (control is prerendered). `doctor` no longer warns about `cacheComponents`; with it on, its Pages check fails a static page that still exports `revalidate`/`dynamicParams` or has no `"use cache"`, and says how to fix it. Docs: the pattern in concepts.md, troubleshooting updated.
