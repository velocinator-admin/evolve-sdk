import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: "esm",
  unbundle: true,
  dts: true,
  platform: "node",
  target: "node22",
});
