// T7.11: the failure matrix of spec §7.9, against the fake cloud.
import { startFakeCloud, TEST_SECRET_KEY, TEST_SITE } from "@next-evolve/fake-cloud";
import { BUNDLE_TTL_SECONDS, newRequestId, signBody } from "@next-evolve/protocol";
import { getRewrittenUrl } from "next/experimental/testing/server";
import type { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys, request } from "../test/proxy-helpers";
import { defineConfig, resolveConfig } from "./config/config";
import { createSql } from "./db/client";
import { applyEvolve } from "./proxy/proxy";
import { handleAggregate } from "./server/aggregate-route";
import { handleSync } from "./server/sync-route";
import { fetchBundle } from "./store/fetch";
import { createMemoryStore } from "./store/memory";

const DAY = 86_400_000;
const config = defineConfig({ routes: { "/": { mode: "static" } } });
const routing = (wB: number) => ({
  routes: { "/": ["k3j9x2"] },
  experiments: {
    k3j9x2: {
      status: "running" as const,
      traffic: 1,
      control: "a8f2l1",
      variants: [
        { id: "a8f2l1", w: 1 - wB },
        { id: "c1d2e3", w: wB },
      ],
    },
  },
});
const variants = {
  a8f2l1: { exp: "k3j9x2", region: "hero", ctrl: true, props: {} },
  c1d2e3: { exp: "k3j9x2", region: "hero", ctrl: false, props: { title: "B" } },
};

let cloud: Awaited<ReturnType<typeof startFakeCloud>> | null;
let t: number;
beforeEach(async () => {
  cloud = await startFakeCloud();
  t = Date.now();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await cloud?.close();
});

/** A store polling the fake cloud every 60 s on a fake clock. */
function appStore(url = cloud!.url) {
  return createMemoryStore({
    site: TEST_SITE,
    keys,
    pollMs: 60_000,
    now: () => t,
    random: () => 0.5,
    fetcher: (etag) => fetchBundle({ cloudUrl: url, secretKey: TEST_SECRET_KEY, etag }),
  });
}
type Store = ReturnType<typeof appStore>;

/** What a new visitor gets on "/": the rewrite path and whether cookies were set. */
function visit(store: Store) {
  const res = applyEvolve(config, request("/"), undefined, { store }) as NextResponse;
  return {
    path: new URL(getRewrittenUrl(res)!).pathname,
    cookies: res.headers.get("set-cookie") ?? "",
  };
}
const servesB = (store: Store) => visit(store).path.includes("c1d2e3");

describe("failure matrix (spec §7.9)", () => {
  it("no bundle at all → control, no cookies", async () => {
    const store = appStore();
    await store.refresh(); // fake cloud: 404 no_bundle
    expect(visit(store)).toEqual({ path: "/ev_0", cookies: "" });
  });

  it("cloud down < 14 days → the last valid bundle keeps serving", async () => {
    cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    const store = appStore();
    await store.refresh();
    expect(servesB(store)).toBe(true);
    await cloud!.close();
    cloud = null;
    t += 13 * DAY;
    await store.refresh(); // network error, logged
    expect(servesB(store)).toBe(true);
  });

  it("cloud down > 14 days → control (the bundle expired)", async () => {
    cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    const store = appStore();
    await store.refresh();
    await cloud!.close();
    cloud = null;
    t += BUNDLE_TTL_SECONDS * 1000 + 1000;
    expect(visit(store)).toEqual({ path: "/ev_0", cookies: "" });
  });

  // T12.6: "disconnected" (key revoked, site removed) is the same as an outage
  // for serving: the cloud answers 401, the last bundle serves until it
  // expires, then control. No instant kill switch from the cloud.
  it("disconnected (key revoked → 401) → the last bundle until it expires, then control", async () => {
    cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    let key = TEST_SECRET_KEY;
    const store = createMemoryStore({
      site: TEST_SITE,
      keys,
      pollMs: 60_000,
      now: () => t,
      random: () => 0.5,
      fetcher: (etag) => fetchBundle({ cloudUrl: cloud!.url, secretKey: key, etag }),
    });
    await store.refresh();
    expect(servesB(store)).toBe(true);
    key = "evk_revoked"; // the cloud answers 401 invalid_key, as for a revoked key
    expect(await fetchBundle({ cloudUrl: cloud!.url, secretKey: key })).toMatchObject({
      status: "error",
      code: 401,
    });
    t += 13 * DAY;
    await store.refresh();
    expect(servesB(store)).toBe(true);
    t += BUNDLE_TTL_SECONDS * 1000 - 13 * DAY + 1000;
    await store.refresh();
    expect(visit(store)).toEqual({ path: "/ev_0", cookies: "" });
  });

  it("webhook unreachable → converges by polling within 60 s", async () => {
    cloud!.publish({ site: TEST_SITE, routing: routing(0), variants });
    const store = appStore();
    await store.refresh();
    expect(servesB(store)).toBe(false);
    cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    const x = await cloud!.webhook("http://127.0.0.1:1"); // app unreachable
    expect(x.status).toBe(0);
    t += 30_000;
    store.peek(); // not due yet: no fetch
    expect(servesB(store)).toBe(false);
    t += 31_000;
    store.peek(); // due: background fetch
    await store.refresh(); // settles the fetch in flight
    expect(servesB(store)).toBe(true);
  });

  it("bad signature or rollback → rejected, the current bundle stays", async () => {
    const v1 = cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    const store = appStore();
    await store.refresh();
    const current = store.token();
    expect(store.load(v1.token)).toBe(false); // rollback
    expect(store.load(`${current!.slice(0, -4)}AAAA`)).toBe(false); // bad signature
    expect(store.token()).toBe(current);
    expect(servesB(store)).toBe(true);
  });

  it("customer DB down → serving unaffected; aggregation answers 503", async () => {
    cloud!.publish({ site: TEST_SITE, routing: routing(1), variants });
    const store = appStore();
    await store.refresh();
    expect(servesB(store)).toBe(true); // the proxy never touches the DB

    const secret = `whsec_${"W".repeat(32)}`;
    const body = JSON.stringify({
      type: "aggregate.request",
      pv: 1,
      requestId: newRequestId(),
      site: TEST_SITE,
      asOf: new Date().toISOString(),
      mode: "incremental",
      usageFrom: null,
      experiments: [
        {
          id: "k3j9x2",
          variants: ["a8f2l1", "c1d2e3"],
          cohortsFrom: "2026-11-20",
          goals: [
            {
              key: "signed_up",
              role: "primary",
              hash: "h",
              def: {
                kind: "event",
                event: "signed_up",
                window: "7d",
                unit: "visitor",
                source: null,
                where: null,
                value: null,
                direction: "increase",
              },
            },
          ],
        },
      ],
    });
    const res = await handleAggregate(
      new Request("http://app.test/api/evolve/aggregate", {
        method: "POST",
        headers: { "evolve-signature": signBody(secret, body), "evolve-delivery": "d1" },
        body,
      }),
      {
        config: resolveConfig(config),
        env: { EVOLVE_WEBHOOK_SECRET: secret, EVOLVE_SECRET_KEY: TEST_SECRET_KEY },
        // Nothing listens on port 1: connection refused.
        sql: () => createSql("postgres://u:p@127.0.0.1:1/db", { max: 1 }),
        sdkVersion: "test",
      },
    );
    expect(res.status).toBe(503);
  });

  it("forged sync webhook → no fetch", async () => {
    const store = appStore();
    const spy = vi.spyOn(store, "refresh");
    const body = JSON.stringify({ pv: 1, type: "bundle.updated", site: TEST_SITE, ver: 9, iat: 1 });
    const res = await handleSync(
      new Request("http://app.test/api/evolve/sync", {
        method: "POST",
        headers: {
          "evolve-signature": signBody(`whsec_${"x".repeat(32)}`, body),
          "evolve-delivery": "d2",
        },
        body,
      }),
      {
        env: {
          EVOLVE_WEBHOOK_SECRET: `whsec_${"W".repeat(32)}`,
          EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
        },
        store: () => store,
      },
    );
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });
});
