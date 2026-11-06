---
"next-evolve": minor
"@next-evolve/protocol": minor
---

Pull-mode aggregation (AGG-2): `aggregate: { mode: "pull" }` in `evolve.config.ts` makes `registerEvolve()` on a long-running Node server poll `GET /v1/aggregate-requests` every 60 s, answer each signed request with the same code as the aggregate route, and post the signed result to `POST /v1/aggregates`. For servers the cloud can't reach. Push stays the default. Protocol 1.2.0 adds `aggregatePullSchema`, `AGGREGATE_PULL_PATH` and the `aggregate-pull.json` fixture; existing messages and fixtures are unchanged.
