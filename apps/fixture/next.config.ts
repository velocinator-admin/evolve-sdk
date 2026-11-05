import type { NextConfig } from "next";
import { evolveRewrites } from "next-evolve/config";
import evolveConfig from "./evolve.config";

// T12.2 perf baseline: `EVOLVE_PERF_BASELINE=1` builds (and starts) the same app
// without Evolve's request path. Only `.tsx` files count as app files, so
// proxy.ts, instrumentation.ts and the API routes are left out; pages are served
// at their variant paths directly (`/ev_0`, `/ev_0/pricing`).
const baseline = process.env.EVOLVE_PERF_BASELINE === "1";

// T19.5a cdnRouting: rewrites are built with it on (see evolve.config.ts).
const nextConfig: NextConfig = baseline
  ? { distDir: ".next-baseline", pageExtensions: ["tsx"] }
  : {
      async rewrites() {
        return {
          beforeFiles: evolveRewrites({ ...evolveConfig, cdnRouting: true }),
          afterFiles: [],
          fallback: [],
        };
      },
    };

export default nextConfig;
