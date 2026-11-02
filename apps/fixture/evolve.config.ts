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
});
