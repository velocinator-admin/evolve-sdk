import type { NextConfig } from "next";

// T12.2 perf baseline: `EVOLVE_PERF_BASELINE=1` builds (and starts) the same app
// without Evolve's request path. Only `.tsx` files count as app files, so
// proxy.ts, instrumentation.ts and the API routes are left out; pages are served
// at their variant paths directly (`/ev_0`, `/ev_0/pricing`).
const baseline = process.env.EVOLVE_PERF_BASELINE === "1";

const nextConfig: NextConfig = baseline
  ? { distDir: ".next-baseline", pageExtensions: ["tsx"] }
  : {};

export default nextConfig;
