import { createServer } from "node:http";
import {
  type AggregateRequest,
  BUNDLE_TYP,
  createKeyRing,
  signBody,
  verifyBody,
  verifyBundle,
} from "@next-evolve/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FakeCloud,
  startFakeCloud,
  TEST_KEY,
  TEST_SECRET_KEY,
  TEST_SITE,
  TEST_WEBHOOK_SECRET,
} from "./index";

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

describe("fake cloud: aggregation", () => {
  const experiments = [
    {
      id: "k3j9x2",
      variants: ["a8f2l1", "c1d2e3"],
      cohortsFrom: "2026-11-20",
      goals: [
        {
          key: "signed_up",
          role: "primary" as const,
          hash: "h",
          def: {
            kind: "event" as const,
            event: "signed_up",
            window: "7d",
            unit: "visitor" as const,
            source: null,
            where: null,
            value: null,
            direction: "increase" as const,
          },
        },
      ],
    },
  ];
  const answer = (req: AggregateRequest) => ({
    pv: 1,
    requestId: req.requestId,
    site: req.site,
    asOf: req.asOf,
    sdk: "test",
    mode: req.mode,
    durationMs: 1,
    partial: false,
    remaining: [],
    rows: [],
    usage: [],
    errors: [],
  });

  /** A stand-in app: verifies the request and answers, signed with `secret`. */
  async function app(secret: string, tamper = false) {
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const c of req) text += c;
      const ok = verifyBody(
        req.headers["evolve-signature"] as string,
        text,
        TEST_WEBHOOK_SECRET,
      ).ok;
      if (!ok) return res.writeHead(401).end();
      const out = JSON.stringify(answer(JSON.parse(text)));
      res.writeHead(200, { "evolve-signature": signBody(secret, tamper ? `${out} ` : out) });
      res.end(out);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  it("sends a signed request and records the verified response", async () => {
    const a = await app(TEST_WEBHOOK_SECRET);
    try {
      const x = await cloud.aggregate(a.url, { experiments, mode: "full" });
      expect(x.status).toBe(200);
      expect(x.verified).toBe(true);
      expect(x.request).toMatchObject({
        type: "aggregate.request",
        pv: 1,
        site: TEST_SITE,
        mode: "full",
      });
      expect(x.response?.requestId).toBe(x.request.requestId);
      expect(cloud.aggregates.at(-1)).toBe(x);
    } finally {
      a.close();
    }
  });

  it("marks responses with a bad signature as unverified", async () => {
    for (const a of [await app(`whsec_${"x".repeat(32)}`), await app(TEST_WEBHOOK_SECRET, true)]) {
      try {
        const x = await cloud.aggregate(a.url, { experiments });
        expect(x.status).toBe(200);
        expect(x.verified).toBe(false);
      } finally {
        a.close();
      }
    }
  });

  it("hands out the queued request and accepts signed uploads only", async () => {
    const r404 = await fetch(`${cloud.url}/v1/aggregates/request`, {
      method: "POST",
      headers: auth,
    });
    expect(r404.status).toBe(404);
    cloud.setAggregateRequest(TEST_SITE, { experiments, usageFrom: "2026-11-20" });
    const r = await fetch(`${cloud.url}/v1/aggregates/request`, { method: "POST", headers: auth });
    const { request } = (await r.json()) as { request: AggregateRequest };
    expect(request).toMatchObject({ site: TEST_SITE, usageFrom: "2026-11-20", experiments });

    const body = JSON.stringify(answer(request));
    const upload = (sig: string) =>
      fetch(`${cloud.url}/v1/aggregates`, {
        method: "POST",
        headers: { ...auth, "evolve-signature": sig },
        body,
      });
    expect((await upload(signBody(TEST_WEBHOOK_SECRET, body))).status).toBe(200);
    expect((await upload(signBody(`whsec_${"x".repeat(32)}`, body))).status).toBe(400);
    expect(cloud.uploads.map((u) => u.verified)).toEqual([true, false]);
  });
});
