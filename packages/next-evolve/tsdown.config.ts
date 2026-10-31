import { defineConfig } from "tsdown";

// Unbundled on purpose: each source file becomes its own output file, so the
// "use client" and "server-only" markers stay attached to the right module.
export default defineConfig({
  entry: ["src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
  format: "esm",
  unbundle: true,
  dts: true,
  platform: "neutral",
  target: "es2023",
});
