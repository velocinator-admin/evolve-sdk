import { EVOLVE_PUBLIC_KEYS } from "@next-evolve/protocol";
import { describe, expect, it, vi } from "vitest";
import { trustedKeySet } from "./keys";

// T12.5: the test signing key is never trusted by a production build unless
// the operator opts in explicitly (SDK e2e only).
const TEST = `e2e-kid:${"A".repeat(43)}`;

describe("trustedKeySet", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  it("ships the production keys and nothing else by default", () => {
    expect(trustedKeySet({ NODE_ENV: "production" })).toEqual(EVOLVE_PUBLIC_KEYS);
    expect(Object.keys(EVOLVE_PUBLIC_KEYS).length).toBeGreaterThan(0);
  });

  it("ignores EVOLVE_UNSAFE_TEST_PUBLIC_KEY in production builds", () => {
    const keys = trustedKeySet({ NODE_ENV: "production", EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST });
    expect(keys).toEqual(EVOLVE_PUBLIC_KEYS);
    expect(keys).not.toHaveProperty("e2e-kid");
    for (const v of ["0", "true", "yes", ""]) {
      expect(
        trustedKeySet({
          NODE_ENV: "production",
          EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST,
          EVOLVE_UNSAFE_ALLOW_TEST_KEY: v,
        }),
      ).not.toHaveProperty("e2e-kid");
    }
  });

  it("trusts it in production only with EVOLVE_UNSAFE_ALLOW_TEST_KEY=1, and outside production", () => {
    expect(
      trustedKeySet({
        NODE_ENV: "production",
        EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST,
        EVOLVE_UNSAFE_ALLOW_TEST_KEY: "1",
      }),
    ).toHaveProperty("e2e-kid");
    expect(
      trustedKeySet({ NODE_ENV: "development", EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST }),
    ).toHaveProperty("e2e-kid");
  });

  it("never lets a test key replace a production kid", () => {
    const [kid] = Object.keys(EVOLVE_PUBLIC_KEYS);
    const keys = trustedKeySet({
      NODE_ENV: "development",
      EVOLVE_UNSAFE_TEST_PUBLIC_KEY: `${kid}:${"B".repeat(43)}`,
    });
    expect(keys[kid!]).toBe(EVOLVE_PUBLIC_KEYS[kid!]);
  });
});
