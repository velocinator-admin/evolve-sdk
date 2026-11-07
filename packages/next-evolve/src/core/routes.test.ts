import { describe, expect, it } from "vitest";
import { compilePattern, routeDir, routeTable } from "./routes";

describe("route patterns (D77)", () => {
  const table = routeTable<string>(
    [
      "/",
      "/pricing",
      "/lp/special",
      "/lp/:slug",
      "/lp/:slug/:step",
      "/:any",
      "/docs/:path*",
      "/docs/api/:name",
      "/shop/:rest+",
      "/lp/:all*",
    ].map((k) => [k, k]),
  );
  const precedence: [string, string | null][] = [
    ["/", "/"],
    ["/pricing", "/pricing"], // exact beats /:any
    ["/lp/special", "/lp/special"], // exact beats /lp/:slug
    ["/lp/a", "/lp/:slug"], // single param beats /lp/:all* and /:any
    ["/lp/a/b", "/lp/:all*"], // one param (catch-all) beats two params
    ["/lp/a/b/c", "/lp/:all*"],
    ["/lp", "/lp/:all*"], // `*` matches zero segments
    ["/features", "/:any"],
    ["/docs", "/docs/:path*"],
    ["/docs/api/x", "/docs/api/:name"], // longer static prefix wins
    ["/docs/guide/x", "/docs/:path*"],
    ["/shop", "/:any"], // `+` needs at least one segment
    ["/shop/a/b", "/shop/:rest+"],
    ["/a/b", null],
  ];
  for (const [path, want] of precedence) {
    it(`${path} → ${want}`, () => expect(table.match(path)?.key ?? null).toBe(want));
  }

  it("bad patterns explain why", () => {
    expect(compilePattern("/lp/:p*/x")).toMatch(/last segment/);
    expect(compilePattern("/lp/[slug]")).toMatch(/literal or :param/);
    expect(compilePattern("/lp/:1x")).toMatch(/literal or :param/);
    expect(compilePattern("/lp/a")).toBe("not a pattern");
  });

  it("literal segments are matched literally", () => {
    const t = routeTable([["/a.b/:x", 1]]);
    expect(t.match("/a.b/1")?.key).toBe("/a.b/:x");
    expect(t.match("/aXb/1")).toBeNull();
  });

  it("routeDir maps patterns to App Router folders", () => {
    expect(routeDir("/")).toBe("");
    expect(routeDir("/pricing")).toBe("pricing");
    expect(routeDir("/lp/:slug")).toBe("lp/[slug]");
    expect(routeDir("/docs/:path*")).toBe("docs/[[...path]]");
    expect(routeDir("/shop/:rest+")).toBe("shop/[...rest]");
  });
});
