import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, string | Record<string, string>>;
};

describe("package exports", () => {
  // Next compiles next.config.ts to CommonJS, so `next-evolve/config` is
  // loaded with require(); an import-only entry fails with
  // ERR_PACKAGE_PATH_NOT_EXPORTED (docs/perf/proxy-overhead.md).
  it("next-evolve/config resolves under require() (default condition)", () => {
    const entry = pkg.exports["./config"] as Record<string, string>;
    expect(entry.default).toBe(entry.import);
  });
});
