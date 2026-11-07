// T20.3 (D76): a UTM rule visitor's exposure lands in segment = rule id, end
// to end: proxy (code + evolve_r) → collect → writer → Postgres → aggregate.
import {
  type AggregateRequest,
  type BundlePayload,
  createReplayGuard,
  newRequestId,
  signBody,
} from "@next-evolve/protocol";
import { getRewrittenUrl } from "next/experimental/testing/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, TEST_DB_URL, testSql } from "../../test/db";
import { request, storeWith } from "../../test/proxy-helpers";
import { sampleBundle } from "../../test/samples";
import { defineConfig, resolveConfig } from "../config/config";
import { createBotDetector } from "../core/bots";
import { createSql } from "../db/client";
import { createWriter } from "../db/writer";
import { applyEvolve } from "../proxy/proxy";
import { handleAggregate } from "./aggregate-route";
import { handleCollect } from "./collect";

const SITE = "site_ab12cd34ef";
const SECRET = `whsec_${"s".repeat(32)}`;
const env = {
  EVOLVE_WEBHOOK_SECRET: SECRET,
  EVOLVE_SECRET_KEY: `evk_live_${SITE}_${"k".repeat(32)}`,
};
type Rule = NonNullable<BundlePayload["rules"]>[number];
const spring: Rule = {
  id: "r1s2t3",
  exp: "k3j9x2",
  var: "c1d2e3",
  when: [{ f: "utm_campaign", op: "eq", v: "spring-sale" }],
};
const withRules = (b: BundlePayload) => {
  b.rules = [spring];
};
const config = defineConfig({
  routes: { "/": { mode: "static" }, "/pricing": { mode: "static" } },
});
const resolved = resolveConfig(config);

const sql = testSql();
const writerSql = createSql(TEST_DB_URL, { max: 2 });
afterAll(async () => {
  await sql.end();
  await writerSql.end();
});
beforeEach(() => freshSchema(sql));

async function collect(
  cookies: Record<string, string>,
  events: unknown[],
  bundle = sampleBundle(withRules),
) {
  const writer = createWriter({ sql: () => writerSql, mode: "serverless" });
  const status = await handleCollect(
    new Request("https://acme.test/api/evolve/collect", {
      method: "POST",
      body: JSON.stringify({ v: 1, events }),
      headers: {
        host: "acme.test",
        origin: "https://acme.test",
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/141.0",
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
    }),
    {
      config: resolved,
      goals: undefined,
      bundle: () => bundle,
      isBot: createBotDetector([]),
      writer,
    },
  );
  expect(status).toBe(204);
  await writer.flush();
}

const exposure = (v: string, p = "/") => ({ t: "exp", e: "k3j9x2", v, p });

async function aggregate() {
  const goal = {
    key: "signed_up",
    role: "primary" as const,
    hash: "h1",
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
  };
  const day = new Date().toISOString().slice(0, 10);
  const body: AggregateRequest = {
    type: "aggregate.request",
    pv: 1,
    requestId: newRequestId(),
    site: SITE,
    asOf: new Date(Date.now() + 60_000).toISOString(),
    mode: "full",
    experiments: [
      { id: "k3j9x2", variants: ["a8f2l1", "c1d2e3"], cohortsFrom: day, goals: [goal] },
    ],
    usageFrom: day,
  } as AggregateRequest;
  const text = JSON.stringify(body);
  const res = await handleAggregate(
    new Request("http://app.test/api/evolve/aggregate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "evolve-signature": signBody(SECRET, text),
        "evolve-delivery": `d-${Math.random()}`,
      },
      body: text,
    }),
    {
      config: resolved,
      env,
      sql: () => writerSql,
      sdkVersion: "9.9.9",
      replay: createReplayGuard(),
    },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { rows: { var: string; seg: string; n: number }[] };
}

describe("segmented exposures (D76)", () => {
  it("a rule visitor's exposure is stored with segment = rule id and aggregated as seg", async () => {
    // The proxy renders the rule's variant and sets evolve_r.
    const res = applyEvolve(config, request("/?utm_campaign=spring-sale"), undefined, {
      store: storeWith(withRules),
      random: () => 0.1,
    });
    expect(new URL(getRewrittenUrl(res!)!).pathname).toBe("/ev_k3j9x2-c1d2e3");
    const cookies = {
      evolve_id: res!.cookies.get("evolve_id")!.value,
      evolve_r: res!.cookies.get("evolve_r")!.value,
    };
    await collect(cookies, [exposure("c1d2e3")]);
    // A plain visitor on the same variant stays main.
    await collect({ evolve_id: "B".repeat(22) }, [exposure("c1d2e3")]);

    const rows =
      await sql`select anon_id, variant_id, segment from evolve.exposures order by anon_id`;
    expect(rows.map((r) => [r.variant_id, r.segment])).toEqual(
      expect.arrayContaining([
        ["c1d2e3", "r1s2t3"],
        ["c1d2e3", null],
      ]),
    );

    const agg = await aggregate();
    const segs = agg.rows.map((r) => `${r.var}/${r.seg}/${r.n}`).sort();
    expect(segs).toEqual(["c1d2e3/main/1", "c1d2e3/r1s2t3/1"]);
  });

  it("a visitor already counted in main stays main (first exposure wins)", async () => {
    const anon = "C".repeat(22);
    await collect({ evolve_id: anon }, [exposure("a8f2l1")]);
    await collect({ evolve_id: anon, evolve_r: "k3j9x2:r1s2t3" }, [exposure("c1d2e3")]);
    const rows =
      await sql`select variant_id, segment from evolve.exposures where anon_id = ${anon}`;
    expect(rows.map((r) => [r.variant_id, r.segment])).toEqual([["a8f2l1", null]]);
  });

  it("evolve_r for another variant, or a rule no longer in the bundle, counts as main", async () => {
    await collect({ evolve_id: "D".repeat(22), evolve_r: "k3j9x2:r1s2t3" }, [exposure("a8f2l1")]);
    await collect(
      { evolve_id: "E".repeat(22), evolve_r: "k3j9x2:r1s2t3" },
      [exposure("c1d2e3")],
      sampleBundle(),
    );
    const rows = await sql`select anon_id, segment from evolve.exposures order by anon_id`;
    expect(rows.map((r) => r.segment)).toEqual([null, null]);
  });

  it("the rule render's static page is the same cached page as an assigned visitor's", () => {
    const store = storeWith(withRules);
    const ruled = applyEvolve(config, request("/pricing?utm_campaign=spring-sale"), undefined, {
      store,
      random: () => 0.1,
    });
    const assigned = applyEvolve(config, request("/pricing"), undefined, {
      store,
      random: () => 0.9,
    });
    const path = (r: typeof ruled) => new URL(getRewrittenUrl(r!)!).pathname;
    expect(path(ruled)).toBe("/ev_k3j9x2-c1d2e3.p7q8r9~s4t5u6/pricing");
    expect(path(ruled)).toBe(path(assigned));
  });
});
