---
"next-evolve": patch
---

Security (T12.5): the sync and aggregate routes now also refuse a signed cloud call that was already seen under another `Evolve-Delivery` id. The delivery id isn't covered by the signature, so before this a captured call could be replayed with a fresh id inside the 5-minute signature window. Calls without a delivery id are refused too.
