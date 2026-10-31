import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
} from "@next-evolve/fake-cloud";
import { verifyBundle } from "@next-evolve/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sampleBundle } from "../../test/samples";
import { trustedKeys } from "../core/keys";
import { fetchBundle } from "./fetch";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
  const b = sampleBundle();
  cloud.publish({ site: TEST_SITE, routing: b.routing, variants: b.variants });
});
afterAll(() => cloud.close());

describe("fetching from the fake cloud", () => {
  it("fetches and verifies a bundle with the test key", async () => {
    const r = await fetchBundle({ cloudUrl: cloud.url, secretKey: TEST_SECRET_KEY });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const keys = trustedKeys({
      NODE_ENV: "development",
      EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
    });
    const v = verifyBundle(r.token, { keys, site: TEST_SITE });
    expect(v.ok).toBe(true);

    const again = await fetchBundle({
      cloudUrl: cloud.url,
      secretKey: TEST_SECRET_KEY,
      etag: r.etag,
    });
    expect(again.status).toBe("not_modified");
  });

  it("rejects the test key when NODE_ENV=production", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await fetchBundle({ cloudUrl: cloud.url, secretKey: TEST_SECRET_KEY });
    if (r.status !== "ok") throw new Error("expected a bundle");
    const keys = trustedKeys({
      NODE_ENV: "production",
      EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
    });
    expect(verifyBundle(r.token, { keys, site: TEST_SITE })).toEqual({
      ok: false,
      reason: "unknown_kid",
    });
    // Explicit double opt-in for SDK e2e against production builds.
    const optIn = trustedKeys({
      NODE_ENV: "production",
      EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
      EVOLVE_UNSAFE_ALLOW_TEST_KEY: "1",
    });
    expect(verifyBundle(r.token, { keys: optIn, site: TEST_SITE }).ok).toBe(true);
    spy.mockRestore();
  });

  it("reports errors without throwing", async () => {
    expect(await fetchBundle({ cloudUrl: cloud.url, secretKey: "evk_live_bad" })).toMatchObject({
      status: "error",
      code: 401,
    });
    expect(
      await fetchBundle({ cloudUrl: "http://127.0.0.1:1", secretKey: TEST_SECRET_KEY }),
    ).toMatchObject({
      status: "error",
      code: "network",
    });
  });
});
