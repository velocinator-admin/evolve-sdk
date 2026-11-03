---
"next-evolve": patch
---

Cold starts no longer wait on the cloud, and `next.config.ts` can import `next-evolve/config` (docs/perf/proxy-overhead.md):

- `registerEvolve` no longer awaits the manifest push. Next awaits `register()` before an instance's first request, so a slow or unreachable cloud delayed every cold start by up to 3 s. The push now runs in the background; failures are still logged.
- `next-evolve/config` gets a `default` export condition, so `next.config.ts` (compiled to CommonJS) can `require` it on Node ≥ 22.12 instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
