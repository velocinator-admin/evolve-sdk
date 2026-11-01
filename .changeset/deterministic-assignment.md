---
"next-evolve": patch
---

Assignment is now deterministic per visitor and experiment (a hash of `evolve_id`), so concurrent first requests from one visitor, such as a link prefetch and the click that follows, can no longer assign two different variants and leave an exposure under the variant the visitor doesn't see.
