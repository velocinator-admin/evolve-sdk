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
    // Protocol 1.1.0: an app answers vitals only when asked.
    ...(req.vitals
      ? {
          vitals: [
            { exp: "k3j9x2", var: "a8f2l1", metric: "lcp", day: req.vitals.from, bins: lcpBins },
          ],
        }
      : {}),
  });
  const lcpBins = Array.from({ length: 25 }, (_, i) => (i === 4 ? 2 : 0));

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

  it("passes a vitals request through and records the vitals it gets back", async () => {
    const a = await app(TEST_WEBHOOK_SECRET);
    try {
      const x = await cloud.aggregate(a.url, { experiments, vitals: { from: "2026-11-20" } });
      expect(x.verified).toBe(true);
      expect(x.request.vitals).toEqual({ from: "2026-11-20" });
      expect(x.response?.vitals).toEqual([
        { exp: "k3j9x2", var: "a8f2l1", metric: "lcp", day: "2026-11-20", bins: lcpBins },
      ]);
      const plain = await cloud.aggregate(a.url, { experiments });
      expect(plain.request).not.toHaveProperty("vitals");
      expect(plain.response).not.toHaveProperty("vitals");
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

describe("fake cloud: sync webhooks", () => {
  type Got = { body: string; sig: string | undefined; delivery: string | undefined; path: string };
  /** A stand-in app that records sync calls and answers `status`. */
  async function app(status = 202) {
    const got: Got[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const c of req) body += c;
      got.push({
        body,
        sig: req.headers["evolve-signature"] as string | undefined,
        delivery: req.headers["evolve-delivery"] as string | undefined,
        path: req.url ?? "",
      });
      res.writeHead(status).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, got, close: () => server.close() };
  }

  it("publish with notify sends a signed bundle.updated webhook and records it", async () => {
    const a = await app();
    try {
      const res = await fetch(`${cloud.url}/__control/publish`, {
        method: "POST",
        body: JSON.stringify({ ...content, notify: a.url }),
      });
      const out = (await res.json()) as { ver: number; iat: number; webhook: { status: number } };
      expect(out.webhook.status).toBe(202);
      expect(a.got).toHaveLength(1);
      const call = a.got[0]!;
      expect(call.path).toBe("/api/evolve/sync");
      expect(verifyBody(call.sig, call.body, TEST_WEBHOOK_SECRET).ok).toBe(true);
      expect(call.delivery).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(call.body)).toEqual({
        pv: 1,
        type: "bundle.updated",
        site: TEST_SITE,
        ver: out.ver,
        iat: out.iat,
      });
      expect(cloud.webhooks.at(-1)).toMatchObject({ status: 202, delivery: call.delivery });
    } finally {
      a.close();
    }
  });

  it("sends pings, forged signatures and replays on request", async () => {
    const a = await app();
    try {
      const ping = await cloud.webhook(a.url, { body: { pv: 1, type: "ping" } });
      expect(JSON.parse(a.got[0]!.body)).toEqual({ pv: 1, type: "ping" });
      await cloud.webhook(a.url, { body: { pv: 1, type: "ping" }, delivery: ping.delivery });
      expect(a.got[1]!.delivery).toBe(ping.delivery);
      await cloud.webhook(a.url, {
        body: { pv: 1, type: "ping" },
        secret: `whsec_${"x".repeat(32)}`,
      });
      expect(verifyBody(a.got[2]!.sig, a.got[2]!.body, TEST_WEBHOOK_SECRET).ok).toBe(false);
      await cloud.webhook(a.url, { body: { pv: 1, type: "ping" }, t: 1 });
      expect(verifyBody(a.got[3]!.sig, a.got[3]!.body, TEST_WEBHOOK_SECRET)).toMatchObject({
        reason: "stale",
      });
    } finally {
      a.close();
    }
  });

  it("records an unreachable app as status 0", async () => {
    const x = await cloud.webhook("http://127.0.0.1:1", { body: { pv: 1, type: "ping" } });
    expect(x.status).toBe(0);
    expect(x.error).toBeTruthy();
  });
});

describe("test controls (T12.1a)", () => {
  it("an outage drops that site's bearer requests and nothing else", async () => {
    cloud.publish(content);
    await fetch(`${cloud.url}/__control/outage`, {
      method: "POST",
      body: JSON.stringify({ site: TEST_SITE, down: true }),
    });
    await expect(
      fetch(`${cloud.url}/v1/bundle`, { headers: { authorization: `Bearer ${TEST_SECRET_KEY}` } }),
    ).rejects.toThrow();
    expect((await fetch(`${cloud.url}/health`)).status).toBe(200);
    cloud.down.delete(TEST_SITE);
    const ok = await fetch(`${cloud.url}/v1/bundle`, {
      headers: { authorization: `Bearer ${TEST_SECRET_KEY}` },
    });
    expect(ok.status).toBe(200);
  });

  it("signs preview tokens the SDK accepts", async () => {
    const { verifyPreview } = await import("@next-evolve/protocol");
    const res = await fetch(`${cloud.url}/__control/preview`, {
      method: "POST",
      body: JSON.stringify({ code: "ev_k3j9x2-c1d2e3" }),
    });
    const { token } = (await res.json()) as { token: string };
    const keys = createKeyRing({ [TEST_KEY.kid]: TEST_KEY.publicKey });
    expect(verifyPreview(token, { keys, site: TEST_SITE })).toMatchObject({
      code: "ev_k3j9x2-c1d2e3",
    });
  });

  it("aggregate() can reuse a delivery id and sign with an old timestamp", async () => {
    const seen: { delivery: string | undefined; sig: string | undefined }[] = [];
    const app = createServer((req, res) => {
      seen.push({
        delivery: req.headers["evolve-delivery"] as string,
        sig: req.headers["evolve-signature"] as string,
      });
      res.writeHead(401).end();
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const port = (app.address() as { port: number }).port;
    await cloud.aggregate(
      `http://127.0.0.1:${port}`,
      { experiments: [] },
      { delivery: "d-1", t: 1000 },
    );
    app.close();
    expect(seen[0]?.delivery).toBe("d-1");
    expect(seen[0]?.sig).toMatch(/^t=1000,/);
  });
});
