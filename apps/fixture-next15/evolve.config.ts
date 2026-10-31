import { defineConfig } from "next-evolve/config";

export default defineConfig({
  routes: { "/": { mode: "static" } },
  sync: { pollSeconds: Number(process.env.EVOLVE_POLL_SECONDS ?? 60) },
});
