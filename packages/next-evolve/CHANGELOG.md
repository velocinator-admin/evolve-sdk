# next-evolve

## 0.3.3

### Patch Changes

- 9b0a086: Sync route: two identical `ping` webhooks signed in the same second both answer again (0.3.2 refused the second as a replay, so a dashboard connection test right after `next-evolve connect --test` could show a failing webhook). A replayed ping changes nothing; `bundle.updated` keeps the full replay check.

## 0.3.2

### Patch Changes

- 80ef751: Security (T12.5): the sync and aggregate routes now also refuse a signed cloud call that was already seen under another `Evolve-Delivery` id. The delivery id isn't covered by the signature, so before this a captured call could be replayed with a fresh id inside the 5-minute signature window. Calls without a delivery id are refused too.

## 0.3.1

### Patch Changes

- 38cbbbe: Collect no longer drops exposures on a cold or stale instance: when a beacon names an experiment the instance's bundle doesn't know yet, the route fetches the bundle (at most once per 5 s per instance, waiting at most 2 s) before validating.
- 354d43c: Assignment is now deterministic per visitor and experiment (a hash of `evolve_id`), so concurrent first requests from one visitor, such as a link prefetch and the click that follows, can no longer assign two different variants and leave an exposure under the variant the visitor doesn't see.

## 0.3.0

### Minor Changes

- 3b87f18: Instant sync and the CLI: the sync webhook route (live in ≤ 5 s), a disk cache and refresh interval on long-running Node, the `prebuild` build bundle (`next-evolve pull`), tagged render-side fetches, Vercel Global Config, and `npx next-evolve init` (incl. the database step and moving static pages) and `doctor`.

## 0.2.2

### Patch Changes

- Fetch the signed bundle over node:http(s) instead of `fetch`. Rendering a variant the render-side bundle didn't know yet (a newly added variant or a preview link) refetched the bundle with an uncached `fetch` inside a static page, which Next fails at runtime ("Page changed from static to dynamic").

## 0.2.1

### Patch Changes

- Exposures record when the beacon arrived (`first_at`) instead of when the batch was written, so conversions that arrive before the next flush are no longer missed by aggregation.

## 0.2.0

### Minor Changes

- Aggregation (M4): `POST /api/evolve/aggregate` answers Evolve Cloud's signed aggregate requests with sufficient statistics computed in your own Postgres (idempotent per request, one at a time, time-budgeted, signed with `EVOLVE_WEBHOOK_SECRET`). New `npx next-evolve aggregate [--upload]` runs the same locally for development.

## 0.1.0

### Minor Changes

- 87d2e91: First public release.

### Patch Changes

- Updated dependencies [87d2e91]
  - @next-evolve/protocol@0.1.0
