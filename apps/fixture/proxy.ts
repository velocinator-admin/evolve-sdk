import { createEvolveProxy } from "next-evolve/proxy";
import buildBundle from "./.evolve/bundle.generated";
import evolveConfig from "./evolve.config";

export const proxy = createEvolveProxy(evolveConfig, { buildBundle });

// evolveMatcher(evolveConfig) with cdnRouting on (T19.5a), written out (Next
// needs a literal). Without the route cookie every entry matches as before.
export const config = {
  matcher: [
    {
      source: "/",
      missing: [
        {
          type: "cookie",
          key: "evolve_r_bo0mse",
          value: "ev_(?:0|[a-z0-9]{6}[-~][a-z0-9]{6}(?:\\.[a-z0-9]{6}[-~][a-z0-9]{6}){0,2})",
        },
      ],
    },
    { source: "/", has: [{ type: "cookie", key: "evolve_pv" }] },
    { source: "/", has: [{ type: "query", key: "evolve_preview" }] },
    {
      source: "/pricing",
      missing: [
        {
          type: "cookie",
          key: "evolve_r_gjovo8",
          value: "ev_(?:0|[a-z0-9]{6}[-~][a-z0-9]{6}(?:\\.[a-z0-9]{6}[-~][a-z0-9]{6}){0,2})",
        },
      ],
    },
    { source: "/pricing", has: [{ type: "cookie", key: "evolve_pv" }] },
    { source: "/pricing", has: [{ type: "query", key: "evolve_preview" }] },
    "/features",
    "/slow",
    "/lp/:slug",
    "/(ev_.*)",
  ],
};
