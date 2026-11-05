import { defineConfig } from "next-evolve/config";

export default defineConfig({
  routes: {
    "/": { mode: "static" },
    "/pricing": { mode: "static" },
    "/features": { mode: "dynamic" },
    // Fixture-only: Core Web Vitals e2e (T17.4).
    "/slow": { mode: "dynamic" },
  },
  // e2e runs poll fast so a publish shows up quickly.
  sync: { pollSeconds: Number(process.env.EVOLVE_POLL_SECONDS ?? 60) },
  // T19.5a: the "cdn" e2e instance turns cdnRouting on at runtime (the build
  // always has the cookie matcher and rewrites; without the route cookie they
  // change nothing, so the other instances behave as before).
  cdnRouting: process.env.EVOLVE_CDN_ROUTING
    ? { maxAgeSeconds: Number(process.env.EVOLVE_CDN_ROUTING) }
    : undefined,
});
