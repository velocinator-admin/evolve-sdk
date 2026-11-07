import type { BundlePayload } from "@next-evolve/protocol";
import { describe, expect, it, vi } from "vitest";
import { sampleBundle } from "../../test/samples";
import {
  compileRules,
  deviceClass,
  firstMatch,
  parseRuleCookie,
  referrerHost,
  requestFacts,
  resolveRules,
  serializeRuleCookie,
} from "./rules";

type Rule = NonNullable<BundlePayload["rules"]>[number];
type Cond = { f: string; op: string; v: string | string[] };

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const bundleWith = (rules: Rule[]) => sampleBundle((b) => (b.rules = rules));
const rule = (when: Cond[], id = "r1s2t3", v = "c1d2e3"): Rule => ({
  id,
  exp: "k3j9x2",
  var: v,
  when: when as Rule["when"],
});

const facts = (path: string, headers: Record<string, string> = {}, geo = "x-vercel-ip-country") =>
  requestFacts(new URL(path, "https://acme.test"), new Headers(headers), geo);

const matches = (cond: Cond, path: string, headers: Record<string, string> = {}) =>
  firstMatch(compileRules(bundleWith([rule([cond])])), "k3j9x2", facts(path, headers)) !== null;

describe("conditions per field and operator", () => {
  const cases: [string, Cond, string, Record<string, string>, boolean][] = [
    ["utm_source eq", { f: "utm_source", op: "eq", v: "google" }, "/?utm_source=google", {}, true],
    [
      "eq ignores case",
      { f: "utm_source", op: "eq", v: "Google" },
      "/?utm_source=GOOGLE",
      {},
      true,
    ],
    ["eq no match", { f: "utm_source", op: "eq", v: "google" }, "/?utm_source=bing", {}, false],
    ["eq absent field", { f: "utm_source", op: "eq", v: "google" }, "/", {}, false],
    [
      "utm_medium in",
      { f: "utm_medium", op: "in", v: ["cpc", "ppc"] },
      "/?utm_medium=ppc",
      {},
      true,
    ],
    ["in no match", { f: "utm_medium", op: "in", v: ["cpc"] }, "/?utm_medium=email", {}, false],
    [
      "utm_campaign prefix",
      { f: "utm_campaign", op: "prefix", v: "spring" },
      "/?utm_campaign=spring-sale",
      {},
      true,
    ],
    [
      "prefix no match",
      { f: "utm_campaign", op: "prefix", v: "spring" },
      "/?utm_campaign=sale-spring",
      {},
      false,
    ],
    ["utm_term re", { f: "utm_term", op: "re", v: "^shoes?$" }, "/?utm_term=shoe", {}, true],
    [
      "re is case-sensitive",
      { f: "utm_term", op: "re", v: "^shoes$" },
      "/?utm_term=SHOES",
      {},
      false,
    ],
    [
      "utm_content eq",
      { f: "utm_content", op: "eq", v: "banner" },
      "/?utm_content=banner",
      {},
      true,
    ],
    [
      "ref host without www",
      { f: "ref", op: "eq", v: "example.com" },
      "/",
      { referer: "https://www.example.com/post?x=1" },
      true,
    ],
    [
      "ref subdomain is its own host",
      { f: "ref", op: "eq", v: "example.com" },
      "/",
      { referer: "https://blog.example.com/" },
      false,
    ],
    ["ref without referer", { f: "ref", op: "eq", v: "example.com" }, "/", {}, false],
    [
      "ref re",
      { f: "ref", op: "re", v: "(^|\\.)google\\." },
      "/",
      { referer: "https://www.google.de/" },
      true,
    ],
    ["country eq", { f: "country", op: "eq", v: "US" }, "/", { "x-vercel-ip-country": "us" }, true],
    [
      "country in",
      { f: "country", op: "in", v: ["DE", "AT"] },
      "/",
      { "x-vercel-ip-country": "AT" },
      true,
    ],
    ["country absent", { f: "country", op: "eq", v: "US" }, "/", {}, false],
    ["device mobile", { f: "device", op: "eq", v: "mobile" }, "/", { "user-agent": IPHONE }, true],
    ["device tablet", { f: "device", op: "eq", v: "tablet" }, "/", { "user-agent": IPAD }, true],
    ["device desktop", { f: "device", op: "eq", v: "desktop" }, "/", { "user-agent": MAC }, true],
    [
      "device not mobile",
      { f: "device", op: "eq", v: "mobile" },
      "/",
      { "user-agent": MAC },
      false,
    ],
  ];
  for (const [name, cond, path, headers, want] of cases) {
    it(name, () => expect(matches(cond, path, headers)).toBe(want));
  }

  it("all conditions must hold (AND)", () => {
    const r = rule([
      { f: "utm_source", op: "eq", v: "google" },
      { f: "device", op: "eq", v: "mobile" },
    ]);
    const c = compileRules(bundleWith([r]));
    expect(
      firstMatch(c, "k3j9x2", facts("/?utm_source=google", { "user-agent": IPHONE })),
    ).not.toBeNull();
    expect(firstMatch(c, "k3j9x2", facts("/?utm_source=google", { "user-agent": MAC }))).toBeNull();
  });

  it("the first matching rule wins, in bundle order", () => {
    const c = compileRules(
      bundleWith([
        rule([{ f: "utm_source", op: "eq", v: "x" }], "aaaaaa", "a8f2l1"),
        rule([{ f: "utm_campaign", op: "eq", v: "s" }], "bbbbbb", "c1d2e3"),
        rule([{ f: "utm_campaign", op: "prefix", v: "s" }], "cccccc", "a8f2l1"),
      ]),
    );
    expect(firstMatch(c, "k3j9x2", facts("/?utm_campaign=s"))?.id).toBe("bbbbbb");
    expect(firstMatch(c, "k3j9x2", facts("/?utm_source=x&utm_campaign=s"))?.id).toBe("aaaaaa");
  });

  it("a configurable geo header", () => {
    const c = compileRules(bundleWith([rule([{ f: "country", op: "eq", v: "FR" }])]));
    expect(
      firstMatch(c, "k3j9x2", facts("/", { "cf-ipcountry": "FR" }, "cf-ipcountry")),
    ).not.toBeNull();
    expect(firstMatch(c, "k3j9x2", facts("/", { "cf-ipcountry": "FR" }))).toBeNull();
  });
});

describe("compileRules", () => {
  it("skips a rule with an invalid regex, an unknown field or operator; others still work", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = compileRules(
      bundleWith([
        rule([{ f: "utm_source", op: "re", v: "(" }], "bad001"),
        rule([{ f: "lang", op: "eq", v: "en" }], "bad002"),
        rule([{ f: "utm_source", op: "contains", v: "x" }], "bad003"),
        rule(
          [
            { f: "utm_source", op: "eq", v: "ok" },
            { f: "utm_source", op: "re", v: "[" },
          ],
          "bad004",
        ),
        rule([{ f: "utm_source", op: "eq", v: "ok" }], "good01"),
      ]),
    );
    expect([...c.byId.keys()]).toEqual(["good01"]);
    expect(firstMatch(c, "k3j9x2", facts("/?utm_source=ok"))?.id).toBe("good01");
    err.mockRestore();
  });

  it("compiles once per bundle object", () => {
    const b = bundleWith([rule([{ f: "utm_source", op: "eq", v: "x" }])]);
    expect(compileRules(b)).toBe(compileRules(b));
  });

  it("a bundle without rules compiles to nothing", () => {
    expect(compileRules(sampleBundle()).byId.size).toBe(0);
  });
});

describe("helpers", () => {
  it("deviceClass", () => {
    expect(deviceClass(IPHONE)).toBe("mobile");
    expect(deviceClass(ANDROID_PHONE)).toBe("mobile");
    expect(deviceClass(IPAD)).toBe("tablet");
    expect(deviceClass(ANDROID_TABLET)).toBe("tablet");
    expect(deviceClass(MAC)).toBe("desktop");
    expect(deviceClass(null)).toBe("desktop");
    expect(deviceClass(MAC, "?1")).toBe("mobile");
  });

  it("referrerHost", () => {
    expect(referrerHost("https://www.Example.com:8443/a")).toBe("example.com");
    expect(referrerHost("http://t.co/x")).toBe("t.co");
    expect(referrerHost("not a url")).toBeNull();
    expect(referrerHost(null)).toBeNull();
  });

  it("evolve_r round-trips and drops malformed entries", () => {
    const m = parseRuleCookie("k3j9x2:r1s2t3.bad.zzzzzz:BAD123.p7q8r9:aaaaaa");
    expect([...m]).toEqual([
      ["k3j9x2", "r1s2t3"],
      ["p7q8r9", "aaaaaa"],
    ]);
    expect(serializeRuleCookie(m)).toBe("k3j9x2:r1s2t3.p7q8r9:aaaaaa");
  });

  it("long inputs are cut before matching", () => {
    const f = facts(`/?utm_term=${"a".repeat(5000)}`);
    expect(f.get("utm_term")!.length).toBe(512);
  });
});

describe("resolveRules", () => {
  const b = bundleWith([rule([{ f: "utm_campaign", op: "eq", v: "spring-sale" }])]);
  const f = (p: string) => () => facts(p);

  it("a match forces the variant and sets the cookie", () => {
    const r = resolveRules(b, ["k3j9x2"], undefined, f("/?utm_campaign=spring-sale"));
    expect([...r.forced]).toEqual([["k3j9x2", { rule: "r1s2t3", var: "c1d2e3" }]]);
    expect(r.cookie).toBe("k3j9x2:r1s2t3");
  });

  it("the session cookie keeps the rule without the UTM", () => {
    const r = resolveRules(b, ["k3j9x2"], "k3j9x2:r1s2t3", f("/"));
    expect(r.forced.get("k3j9x2")?.var).toBe("c1d2e3");
    expect(r.cookie).toBeNull();
  });

  it("a cookie rule that left the bundle is dropped and rules re-evaluated", () => {
    const r = resolveRules(b, ["k3j9x2"], "k3j9x2:gone00", f("/"));
    expect(r.forced.size).toBe(0);
    expect(r.cookie).toBe("");
  });

  it("no rules and no cookie: nothing to do, facts never read", () => {
    const facts = vi.fn();
    const r = resolveRules(sampleBundle(), ["k3j9x2"], undefined, facts);
    expect(r).toEqual({ forced: new Map(), cookie: null });
    expect(facts).not.toHaveBeenCalled();
  });

  it("experiments that aren't running aren't forced", () => {
    const done = sampleBundle((x) => {
      x.routing.routes["/x"] = ["p7q8r9"];
    });
    expect(resolveRules(done, ["p7q8r9"], "p7q8r9:r1s2t3", f("/")).forced.size).toBe(0);
  });
});
