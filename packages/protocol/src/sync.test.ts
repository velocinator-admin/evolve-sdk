import { describe, expect, it } from "vitest";
import { syncWebhookSchema } from "./sync";

describe("sync webhook body", () => {
  it("parses bundle.updated and ping", () => {
    expect(
      syncWebhookSchema.safeParse({
        pv: 1,
        type: "bundle.updated",
        site: "site_ab12cd34ef",
        ver: 4,
        iat: 1,
      }).success,
    ).toBe(true);
    expect(syncWebhookSchema.safeParse({ pv: 1, type: "ping" }).success).toBe(true);
  });
  it("rejects unknown types and missing fields", () => {
    expect(syncWebhookSchema.safeParse({ pv: 1, type: "config", data: {} }).success).toBe(false);
    expect(syncWebhookSchema.safeParse({ pv: 1, type: "bundle.updated" }).success).toBe(false);
  });
});
