import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aggregateRequestSchema } from "./aggregate";
import { verifyBody } from "./hmac";
import { aggregatePullSchema, MAX_PULL_REQUESTS } from "./pull";

const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/v1/${f}`, import.meta.url), "utf8"));

describe("aggregate pull (1.2.0)", () => {
  it("each pulled body is a push request, signed the same way", () => {
    const pull = aggregatePullSchema.parse(fixture("aggregate-pull.json"));
    const [item] = pull.requests;
    const sig = verifyBody(item!.signature, item!.body, "whsec_fixture", { now: 1_795_000_000 });
    expect(sig.ok).toBe(true);
    expect(aggregateRequestSchema.parse(JSON.parse(item!.body))).toEqual(
      fixture("aggregate-request.json"),
    );
  });

  it("an empty poll is valid; too many requests is not", () => {
    expect(aggregatePullSchema.safeParse({ pv: 1, requests: [] }).success).toBe(true);
    const item = { delivery: "d", signature: "t=1,v1=00", body: "{}" };
    const many = { pv: 1, requests: Array.from({ length: MAX_PULL_REQUESTS + 1 }, () => item) };
    expect(aggregatePullSchema.safeParse(many).success).toBe(false);
  });
});
