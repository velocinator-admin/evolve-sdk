---
"next-evolve": minor
---

Core Web Vitals storage: migration `0002_vitals` adds `evolve.vitals_daily` (counts per experiment × variant × metric × UTC day × bin; no visitor id). It only adds a table, so `next-evolve migrate` is safe on a live database. The collect route accepts `{ t: "cwv", m, v, p }` beacon events, attributes them to the counted experiment/variant pairs the same batch reports for that page (pairs in the local bundle only), and writes one upsert per batch. Bots, previews, visitors without an Evolve id, unknown pairs and out-of-range values (negative, over 10 minutes, CLS over 10) are dropped.
