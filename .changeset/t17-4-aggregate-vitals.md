---
"next-evolve": minor
---

The aggregate route (and `next-evolve aggregate`) answers protocol 1.1.0's `vitals: { from }`: one `group by` over `evolve.vitals_daily` for the requested experiments and variants (only the experiments the response returns), from `from` to the request's day, pivoted into one `bins` array per experiment × variant × metric × day (at most 5,000 rows). It counts against the same time budget. If it fails, runs out of time or would exceed the cap, the response has an `errors` entry with `goal: "$vitals"` and no `vitals`. Without `vitals` in the request the response is unchanged. Docs: "What leaves your server" and "Concepts" describe the vitals histograms.
