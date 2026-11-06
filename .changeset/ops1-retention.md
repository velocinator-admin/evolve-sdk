---
"next-evolve": minor
---

Local retention (OPS-1): `retentionDays` (minimum 30; unset = nothing is deleted, as before) deletes old local events, vitals days and the exposures of stopped experiments once a day, from inside aggregate requests (push or pull), in batches of 5,000 rows. It never deletes data a running or paused experiment still needs. New migration `0003_retention` (two small tables): run `npx next-evolve migrate`.
