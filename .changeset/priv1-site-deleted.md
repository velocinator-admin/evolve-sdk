---
"next-evolve": patch
---

Deleted sites fail safe (PRIV-1): when the cloud answers `410 {"error":"site_deleted"}`, the app drops its cached bundle and serves control at once instead of keeping it up to 14 days, and refuses the old bundle from the build bundle, disk cache or Global Config. `next-evolve pull` writes an empty build bundle; `doctor` and the CLI say the site was deleted. A `401` (revoked key, key rotation, a preview env with the wrong key) keeps the old behaviour: the last bundle serves until it expires. The fake cloud gains `deleted` / `rejected` site sets (`POST /__control/site`).
