import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateRequestSchema, aggregateResponseSchema } from "./aggregate";
import { bundlePayloadSchema, computeBundleHash } from "./bundle";
import { syncWebhookSchema } from "./sync";
import { SUPPORTED_PROTOCOLS } from "./version";

const schemas = {
  "bundle-payload": bundlePayloadSchema,
  "webhook-bundle-updated": syncWebhookSchema,
  "webhook-ping": syncWebhookSchema,
  "aggregate-request": aggregateRequestSchema,
  "aggregate-response": aggregateResponseSchema,
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
