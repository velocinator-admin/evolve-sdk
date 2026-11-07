import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareRoutes,
  compileConstraint,
  compileRoute,
  constraintError,
  exampleRoutePaths,
  hasConstraint,
  MAX_CONSTRAINT_LENGTH,
  parseRouteKey,
  routeKeyError,
  routeParamNames,
} from "./routes";

const PERSON = "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)";

describe("route keys (D77 + TPL-1.1)", () => {
  it.each([
    "/",
    "/pricing",
    "/lp/:slug",
    "/docs/:path*",
    "/docs/:path+",
    PERSON,
    "/:name/:state/:city/:id(z[0-9]+)",
    "/p/:id(\\d{1,8})",
    "/c/:code((?:ab|cd)x)",
  ])("accepts %s", (k) => expect(routeKeyError(k)).toBeNull());

  it.each([
    ["pricing", "must start with /"],
    ["/lp/[slug]", "must be a path or a pattern"],
    ["/lp/:p*/x", "must be the last segment"],
    ["/lp/:1x", "must be a literal or :param"],
    ["/:a/:a", "appears twice"],
    ["/:x([a-z/]+)", "can't contain /"],
    ["/:x([a-z]+)*", "exactly one segment"],
    ["/:x()", "empty constraint"],
    ["/:x(a(b))", "capturing groups"],
    ["/:x((?<n>a))", "capturing groups"],
    ["/:x((a)\\1)", "capturing groups"],
    ["/:x(a\\1)", "backreferences"],
    ["/:x((?=a)a)", "lookarounds"],
    ["/:x((?!a)b)", "lookarounds"],
    ["/:x((?<=a)b)", "lookarounds"],
    ["/:x((?:a+)+)", "nested quantifiers"],
    ["/:x((?:a*)*b)", "nested quantifiers"],
    ["/:x((?:a|aa)+)", "can't contain |"],
    ["/:x(a**)", "nested quantifiers"],
    ["/:x(^a$)", "anchored already"],
    ["/:x(a*)", "matches an empty segment"],
    ["/:x([a-z)", "unclosed ["],
    ["/:x(a{3,1})", "below the minimum"],
    ["/:x(a{500})", "up to 100"],
    ["/:x(\\p{L})", "isn't supported"],
  ])("refuses %s (%s)", (k, msg) => expect(routeKeyError(k)).toContain(msg));

  it(`constraints are at most ${MAX_CONSTRAINT_LENGTH} characters`, () => {
    expect(constraintError("a".repeat(MAX_CONSTRAINT_LENGTH))).toBeNull();
    expect(constraintError("a".repeat(MAX_CONSTRAINT_LENGTH + 1))).toContain("at most");
  });

  it("param names, constraint detection", () => {
    expect(routeParamNames("/:name/:state/:city/:id(z[0-9]+)")).toEqual([
      "name",
      "state",
      "city",
      "id",
    ]);
    expect(routeParamNames("/pricing")).toEqual([]);
    expect(hasConstraint(PERSON)).toBe(true);
    expect(hasConstraint("/lp/:slug")).toBe(false);
    expect(parseRouteKey("/a/b")).toBe("not a pattern");
  });
});

describe("constraint matching", () => {
  const person = compileConstraint("[A-Z][A-Za-z]*-[A-Za-z-]+");
  it.each([
    ["Christopher-G", true],
    ["Christopher-Titus", true],
    ["Mary-Ann-Smith", true],
    ["pricing", false],
    ["about", false],
    ["Christopher", false],
    ["christopher-g", false],
    ["Christopher-", false],
    ["", false],
  ])("%s → %s", (s, want) => expect(person(s)).toBe(want));

  it.each([
    ["z[0-9]+", "z1581", true],
    ["z[0-9]+", "z", false],
    ["\\d{1,3}", "123", true],
    ["\\d{1,3}", "1234", false],
    ["(?:ab|cd)x", "cdx", true],
    ["(?:ab|cd)x", "abcdx", false],
    ["[^-]+", "abc", true],
    ["[^-]+", "a-c", false],
    ["\\D+", "abc", true],
    ["\\D+", "a1", false],
    ["a.c", "a%c", true],
    ["[\\w.]+", "a.b_c", true],
    ["[a\\-z]+", "a-z", true],
    ["[a\\-z]+", "b", false],
    ["a?b", "b", true],
    ["a{2,}", "aaaa", true],
    ["a{2,}", "a", false],
    ["\\.html", ".html", true],
    ["\\.html", "xhtml", false],
  ])("%s on %s → %s", (re, s, want) => expect(compileConstraint(re)(s)).toBe(want));

  it("agrees with a native anchored RegExp (property)", () => {
    const res = ["[A-Z][A-Za-z]*-[A-Za-z-]+", "z[0-9]+", "(?:ab|cd)x", "[a-c]{1,3}d?"];
    for (const re of res) {
      const ours = compileConstraint(re);
      const native = new RegExp(`^(?:${re})$`);
      fc.assert(
        fc.property(fc.stringMatching(/^[A-Za-z0-9-]{0,12}$/), (s) => ours(s) === native.test(s)),
        { numRuns: 300 },
      );
    }
  });

  it("is linear: a hostile 100 kB segment against a polynomial-for-backtracking constraint", () => {
    const test = compileConstraint("[a-z]*[a-z]*[a-z]*[a-z]*b");
    const s = "a".repeat(100_000);
    const t0 = performance.now();
    expect(test(s)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("compiled routes", () => {
  it("returns params; constraints test the raw segment", () => {
    const r = compileRoute("/:name/:state/:city/:id(z[0-9]+)");
    if (typeof r === "string") throw new Error(r);
    expect(r.match("/Christopher-Titus/Michigan/Marlette/z1581")).toEqual({
      name: "Christopher-Titus",
      state: "Michigan",
      city: "Marlette",
      id: "z1581",
    });
    expect(r.match("/a/b/c/x1")).toBeNull();
    const d = compileRoute("/docs/:path*");
    if (typeof d === "string") throw new Error(d);
    expect(d.match("/docs/a/b")).toEqual({ path: ["a", "b"] });
    expect(d.match("/docs")).toEqual({ path: [] });
  });

  it("constrained patterns sort before unconstrained, then D77 specificity", () => {
    const keys = ["/:any", "/lp/:slug", PERSON, "/:a/:b(z[0-9]+)"];
    const sorted = keys
      .map((k) => compileRoute(k))
      .filter((r) => typeof r !== "string")
      .sort(compareRoutes)
      .map((r) => r.key);
    expect(sorted).toEqual([PERSON, "/:a/:b(z[0-9]+)", "/lp/:slug", "/:any"]);
  });

  it("example paths match their pattern", () => {
    for (const k of [PERSON, "/:name/:state/:city/:id(z[0-9]+)", "/lp/:slug", "/docs/:p*"]) {
      const ex = exampleRoutePaths(k, 3);
      const r = compileRoute(k);
      if (typeof r === "string") throw new Error(r);
      expect(ex.length).toBeGreaterThan(0);
      for (const p of ex) expect(r.match(p), `${k} ${p}`).not.toBeNull();
    }
    expect(exampleRoutePaths(PERSON, 3)).toHaveLength(3);
    expect(exampleRoutePaths("/lp/:slug")).toEqual(["/lp/slug"]);
    expect(exampleRoutePaths("/pricing")).toEqual(["/pricing"]);
  });
});
