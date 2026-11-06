import { readdirSync, readFileSync } from "node:fs";
import {
  aggregateRequestSchema as aggregateRequestSchema100,
  aggregateResponseSchema as aggregateResponseSchema100,
} from "protocol-1.0.0";
import { describe, expect, it } from "vitest";
import { aggregateRequestSchema, aggregateResponseSchema } from "./aggregate";
import { bundlePayloadSchema, computeBundleHash } from "./bundle";
import { aggregatePullSchema } from "./pull";
import { syncWebhookSchema } from "./sync";
import { SUPPORTED_PROTOCOLS } from "./version";

const schemas = {
  "bundle-payload": bundlePayloadSchema,
  "webhook-bundle-updated": syncWebhookSchema,
  "webhook-ping": syncWebhookSchema,
  "aggregate-request": aggregateRequestSchema,
  "aggregate-response": aggregateResponseSchema,
  "aggregate-request-vitals": aggregateRequestSchema,
  "aggregate-response-vitals": aggregateResponseSchema,
  "aggregate-pull": aggregatePullSchema,
} as const;

for (const pv of SUPPORTED_PROTOCOLS) {
  const dir = new URL(`../fixtures/v${pv}/`, import.meta.url);
  describe(`contract fixtures v${pv}`, () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

    it("covers every message type", () => {
      expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(
        Object.keys(schemas).sort(),
      );
    });

    for (const f of files) {
      it(`${f} parses and declares pv ${pv}`, () => {
        const data = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
        const schema = schemas[f.replace(/\.json$/, "") as keyof typeof schemas];
        const r = schema.safeParse(data);
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
        expect(data.pv).toBe(pv);
      });
    }

    it("bundle fixture hash matches its content", () => {
      const b = JSON.parse(readFileSync(new URL("bundle-payload.json", dir), "utf8"));
      expect(b.hash).toBe(computeBundleHash(b));
    });
  });
}

// Protocol 1.1.0 only adds: 1.0.0 readers (SDK 0.4.x, the cloud before T17.6) accept the
// vitals messages, and the 1.0.0 fixtures ship byte-identical.
describe("compatibility with @next-evolve/protocol 1.0.0", () => {
  const dir = new URL("../fixtures/v1/", import.meta.url);
  const oldDir = new URL("../node_modules/protocol-1.0.0/fixtures/v1/", import.meta.url);
  const read = (d: URL, f: string) => readFileSync(new URL(f, d), "utf8");

  it("every 1.0.0 fixture is byte-identical", () => {
    const old = readdirSync(oldDir).filter((f) => f.endsWith(".json"));
    expect(old.length).toBe(5);
    for (const f of old) expect(read(dir, f), f).toBe(read(oldDir, f));
  });

  it("1.0.0's schemas parse the new vitals fixtures (loose objects)", () => {
    const req = JSON.parse(read(dir, "aggregate-request-vitals.json"));
    const res = JSON.parse(read(dir, "aggregate-response-vitals.json"));
    expect(req.vitals).toBeDefined();
    expect(res.vitals.length).toBeGreaterThan(0);
    const r1 = aggregateRequestSchema100.safeParse(req);
    const r2 = aggregateResponseSchema100.safeParse(res);
    expect(r1.success, JSON.stringify(r1.error?.issues)).toBe(true);
    expect(r2.success, JSON.stringify(r2.error?.issues)).toBe(true);
  });

  it("the vitals fixtures are the 1.0.0 ones plus `vitals`", () => {
    for (const name of ["aggregate-request", "aggregate-response"]) {
      const { vitals, ...rest } = JSON.parse(read(dir, `${name}-vitals.json`));
      expect(vitals, name).toBeDefined();
      expect(rest, name).toEqual(JSON.parse(read(oldDir, `${name}.json`)));
    }
  });
});
