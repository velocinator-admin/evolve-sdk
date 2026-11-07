---
"next-evolve": patch
---

`doctor` requests your live site and names the CDN in front of it from the response headers: Cloudflare (`cf-ray`, `server: cloudflare`) and Netlify warn with what to check, and a tested route served from the CDN's cache (`cf-cache-status: HIT`) fails, since every visitor would get one variant. New docs page `hosting.md`: Docker standalone, Cloudflare cache rules that never serve one variant to everyone, Netlify (beta, unverified).
