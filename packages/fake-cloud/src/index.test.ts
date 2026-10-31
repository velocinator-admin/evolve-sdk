import { BUNDLE_TYP, createKeyRing, verifyBundle } from "@next-evolve/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeCloud, startFakeCloud, TEST_KEY, TEST_SECRET_KEY, TEST_SITE } from "./index";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
});
afterAll(() => cloud.close());

const content = {
  site: TEST_SITE,
  routing: {
    routes: { "/": ["k3j9x2"] },
    experiments: {
      k3j9x2: {
        status: "running" as const,
        traffic: 1,
        control: "a8f2l1",
        variants: [
          { id: "a8f2l1", w: 0.5 },
          { id: "c1d2e3", w: 0.5 },
        ],
      },
    },
  },
  variants: {
    a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
    c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "B" } },
  },
};
const auth = { authorization: `Bearer ${TEST_SECRET_KEY}` };

describe("fake cloud", () => {
  it("rejects requests without a valid key", async () => {
    expect((await fetch(`${cloud.url}/v1/bundle`)).status).toBe(401);
  });

  it("404s before anything is published", async () => {
    expect((await fetch(`${cloud.url}/v1/bundle`, { headers: auth })).status).toBe(404);
  });

  it("publishes via the control API and serves a verifiable bundle with ETag/304", async () => {
    const pub = await fetch(`${cloud.url}/__control/publish`, {
      method: "POST",
      body: JSON.stringify(content),
    });
    expect(pub.status).toBe(200);

    const res = await fetch(`${cloud.url}/v1/bundle`, { headers: auth });
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag")!;
    const token = await res.text();
    const r = verifyBundle(token, {
      keys: createKeyRing({ [TEST_KEY.kid]: TEST_KEY.publicKey }),
      site: TEST_SITE,
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload.ver).toBe(1);
    expect(token.split(".")[0]).toBe(
      Buffer.from(JSON.stringify({ alg: "EdDSA", kid: TEST_KEY.kid, typ: BUNDLE_TYP })).toString(
        "base64url",
      ),
    );

    const again = await fetch(`${cloud.url}/v1/bundle`, {
      headers: { ...auth, "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("bumps ver on each publish", () => {
    const a = cloud.publish(content).payload.ver;
    expect(cloud.publish(content).payload.ver).toBe(a + 1);
  });
});
