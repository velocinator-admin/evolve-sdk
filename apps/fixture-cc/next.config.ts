import type { NextConfig } from "next";

// T23.3 (HOST-2): static mode with Cache Components. Pages under app/[evolve]/
// cache per variant code with "use cache" + cacheLife instead of segment config.
const nextConfig: NextConfig = { cacheComponents: true };

export default nextConfig;
