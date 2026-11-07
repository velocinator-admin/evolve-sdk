import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { evolveRewrites } from "next-evolve/config";
import evolveConfig from "./evolve.config";

// T12.2 perf baseline: `EVOLVE_PERF_BASELINE=1` builds (and starts) the same app
// without Evolve's request path. Only `.tsx` files count as app files, so
// proxy.ts, instrumentation.ts and the API routes are left out; pages are served
// at their variant paths directly (`/ev_0`, `/ev_0/pricing`).
const baseline = process.env.EVOLVE_PERF_BASELINE === "1";

// T23.1 host matrix: `EVOLVE_STANDALONE=1` builds `output: "standalone"` (the
// Docker image, Dockerfile.standalone). Traced from the monorepo root so the
// workspace packages land in the bundle.
const standalone: NextConfig =
  process.env.EVOLVE_STANDALONE === "1"
    ? {
        output: "standalone",
        outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "../.."),
      }
    : {};

// T19.5a cdnRouting: rewrites are built with it on (see evolve.config.ts).
const nextConfig: NextConfig = baseline
  ? { ...standalone, distDir: ".next-baseline", pageExtensions: ["tsx"] }
  : {
      ...standalone,
      async rewrites() {
        return {
          beforeFiles: evolveRewrites({ ...evolveConfig, cdnRouting: true }),
          afterFiles: [],
          fallback: [],
        };
      },
    };

export default nextConfig;
