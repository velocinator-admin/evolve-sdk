---
"next-evolve": patch
---

Sync route: two identical `ping` webhooks signed in the same second both answer again (0.3.2 refused the second as a replay, so a dashboard connection test right after `next-evolve connect --test` could show a failing webhook). A replayed ping changes nothing; `bundle.updated` keeps the full replay check.
