import { afterEach, describe, expect, it } from "vitest";
import { closeAllSql, getSql, isServerless } from "./client";

afterEach(() => closeAllSql());

describe("db client", () => {
  it("is null without a URL", () => {
    expect(getSql("EVOLVE_DATABASE_URL", {})).toBeNull();
  });

  it("is one lazy pool per URL (no connection until a query)", () => {
    const env = { MY_DB: "postgres://u:p@127.0.0.1:1/db" };
    const a = getSql("MY_DB", env);
    expect(a).not.toBeNull();
    expect(getSql("MY_DB", env)).toBe(a);
    expect(a?.options.prepare).toBe(false);
  });

  it("uses one connection per instance on serverless hosts", () => {
    expect(isServerless({ VERCEL: "1" })).toBe(true);
    expect(isServerless({})).toBe(false);
    const sql = getSql("U", { U: "postgres://u:p@127.0.0.1:1/db", VERCEL: "1" });
    expect(sql?.options.max).toBe(1);
  });
});
