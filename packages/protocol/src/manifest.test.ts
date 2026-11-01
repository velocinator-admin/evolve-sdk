import { describe, expect, it } from "vitest";
import {
  computeManifestHash,
  MAX_REGION_SCHEMA_BYTES,
  manifestSchema,
  regionRegistrationSchema,
} from "./manifest";

const routes = { "/": { mode: "static" as const } };
const goals = {
  signup: {
    kind: "event" as const,
    event: "signup",
    source: null,
    where: null,
    value: null,
    window: "7d",
    unit: "visitor" as const,
    direction: "increase" as const,
  },
};
const manifest = {
  pv: 1,
  sdkVersion: "0.1.0",
  protocol: { supported: [1] },
  nextVersion: "16.4.3",
  routes,
  goals,
  hash: computeManifestHash({ routes, goals }),
  appUrl: "https://acme.com",
};

describe("manifest", () => {
  it("accepts a valid manifest and keeps unknown fields", () => {
    const r = manifestSchema.safeParse({ ...manifest, later: true });
    expect(r.success && (r.data as { later?: boolean }).later).toBe(true);
  });

  it("hash ignores key order and changes with content", () => {
    expect(computeManifestHash({ goals, routes })).toBe(manifest.hash);
    expect(computeManifestHash({ routes: {}, goals })).not.toBe(manifest.hash);
  });

  it.each([
    ["a bad goal key", { goals: { "Bad-Key": goals.signup } }],
    ["a relative route", { routes: { pricing: { mode: "static" } } }],
    ["a non-http appUrl", { appUrl: "javascript:alert(1)" }],
    ["no supported versions", { protocol: { supported: [] } }],
  ])("rejects %s", (_, patch) => {
    expect(manifestSchema.safeParse({ ...manifest, ...patch }).success).toBe(false);
  });
});

describe("region registration", () => {
  const region = {
    pv: 1,
    id: "hero",
    jsonSchema: { type: "object" },
    schemaHash: "a".repeat(64),
    controlProps: { title: "Ship faster" },
    path: "/",
  };
  it("accepts a valid region", () => {
    expect(regionRegistrationSchema.safeParse(region).success).toBe(true);
  });
  it("caps the schema size and validates the id", () => {
    const big = { type: "object", description: "x".repeat(MAX_REGION_SCHEMA_BYTES) };
    expect(regionRegistrationSchema.safeParse({ ...region, jsonSchema: big }).success).toBe(false);
    expect(regionRegistrationSchema.safeParse({ ...region, id: "Hero!" }).success).toBe(false);
  });
});
