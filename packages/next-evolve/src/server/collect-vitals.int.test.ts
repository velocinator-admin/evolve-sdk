// T17.2: beacon `cwv` events → evolve.vitals_daily (Phase 2 spec §9.5), on a real customer DB.
import { binFor } from "@next-evolve/protocol";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { freshSchema, testSql } from "../../test/db";
import { sampleBundle } from "../../test/samples";
import { defineConfig, resolveConfig } from "../config/config";
import { createBotDetector } from "../core/bots";
import { createWriter } from "../db/writer";
import { handleCollect } from "./collect";

const sql = testSql();
beforeEach(() => freshSchema(sql));
afterAll(() => sql.end());

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const writer = createWriter({ sql: () => sql, mode: "serverless" });
const deps = {
  config: resolveConfig(defineConfig({ routes: { "/": { mode: "static" } } })),
  goals: undefined,
  bundle: () => sampleBundle(),
  isBot: createBotDetector([]),
  writer,
  now: () => new Date("2026-11-02T12:00:00Z"),
};

const post = async (events: unknown[], anon: string, ua = UA) => {
  const status = await handleCollect(
    new Request("https://acme.test/api/evolve/collect", {
      method: "POST",
      body: JSON.stringify({ v: 1, events }),
      headers: {
        host: "acme.test",
        origin: "https://acme.test",
        "user-agent": ua,
        cookie: `evolve_id=${anon}`,
      },
    }),
    deps,
  );
  await writer.flush();
  return status;
};
const page = (variant: string, lcp: number, cls: number, inp: number) => [
  { t: "exp", e: "k3j9x2", v: variant, p: "/" },
  { t: "cwv", m: "lcp", v: lcp, p: "/" },
  { t: "cwv", m: "cls", v: cls, p: "/" },
  { t: "cwv", m: "inp", v: inp, p: "/" },
];
const histogram = async () =>
  (
    await sql`select variant_id, metric, to_char(day, 'YYYY-MM-DD') as day, bin, count::int as n
      from evolve.vitals_daily order by variant_id, metric, bin`
  ).map((r) => `${r.variant_id}:${r.metric}:${r.day}:${r.bin}=${r.n}`);

describe("collect → vitals_daily", () => {
  it("increments one bin per metric for the page's counted pair", async () => {
    expect(await post(page("c1d2e3", 1200, 0.12, 180), "AAAAAAAAAAAAAAAAAAAAAA")).toBe(204);
    expect(await post(page("c1d2e3", 1100, 0.3, 60), "BBBBBBBBBBBBBBBBBBBBBB")).toBe(204);
    expect(await post(page("a8f2l1", 3000, 0, 16), "CCCCCCCCCCCCCCCCCCCCCC")).toBe(204);
    const bin = (m: "lcp" | "cls" | "inp", v: number) => binFor(m, v);
    expect(await histogram()).toEqual([
      `a8f2l1:cls:2026-11-02:${bin("cls", 0)}=1`,
      `a8f2l1:inp:2026-11-02:${bin("inp", 16)}=1`,
      `a8f2l1:lcp:2026-11-02:${bin("lcp", 3000)}=1`,
      `c1d2e3:cls:2026-11-02:${bin("cls", 0.12)}=1`,
      `c1d2e3:cls:2026-11-02:${bin("cls", 0.3)}=1`,
      `c1d2e3:inp:2026-11-02:${bin("inp", 60)}=1`,
      `c1d2e3:inp:2026-11-02:${bin("inp", 180)}=1`,
      `c1d2e3:lcp:2026-11-02:${bin("lcp", 1200)}=2`,
    ]);
    // Exposures are still recorded as before; vitals rows hold no visitor id.
    expect((await sql`select count(*)::int as n from evolve.exposures`)[0]?.n).toBe(3);
  });

  it("stores nothing for a bot or an unknown pair", async () => {
    await post(page("c1d2e3", 1200, 0.1, 100), "AAAAAAAAAAAAAAAAAAAAAA", "Googlebot/2.1");
    await post(page("zzzzzz", 1200, 0.1, 100), "AAAAAAAAAAAAAAAAAAAAAA");
    expect(await histogram()).toEqual([]);
  });
});
