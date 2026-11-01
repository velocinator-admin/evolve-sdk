# next-evolve

## 0.2.0

### Minor Changes

- Aggregation (M4): `POST /api/evolve/aggregate` answers Evolve Cloud's signed aggregate requests with sufficient statistics computed in your own Postgres (idempotent per request, one at a time, time-budgeted, signed with `EVOLVE_WEBHOOK_SECRET`). New `npx next-evolve aggregate [--upload]` runs the same locally for development.

## 0.1.0

### Minor Changes

- 87d2e91: First public release.

### Patch Changes

- Updated dependencies [87d2e91]
  - @next-evolve/protocol@0.1.0
