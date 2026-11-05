---
"next-evolve": patch
---

Faster rollbacks with Global Config (T19.5). Instances re-read Global Config every 5 s instead of 10 s. The sync route now pulls the published bundle from the cloud, not the Global Config item it is about to replace. It also writes Global Config when its own instance already had the webhook's version.
