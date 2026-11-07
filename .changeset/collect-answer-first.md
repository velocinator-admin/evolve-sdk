---
"next-evolve": patch
---

Collect answers a beacon right away when its batch names a pair the bundle doesn't route, and records the batch after the response (`after()`) once the on-demand refresh is done. Before, the beacon request stayed open for up to 12 s. After a pause, pages a visitor still had (with `cdnRouting`, for the route cookie's lifetime) sent such beacons, and on HTTP/1.1 each one held one of the browser's 6 connections to the site, so the visitor's next page loads stalled for several seconds.
