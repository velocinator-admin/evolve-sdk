import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FakeCloud,
  startFakeCloud,
  TEST_PUBLIC_KEY_ENV,
  TEST_SECRET_KEY,
  TEST_SITE,
  TEST_WEBHOOK_SECRET,
} from "@next-evolve/fake-cloud";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freshApp } from "../../test/apps";
import type { EvolveConfig } from "../config/config";
import { type Check, type DoctorDeps, runDoctor } from "./doctor";
import { initCommand } from "./init";

let cloud: FakeCloud;
beforeAll(async () => {
  cloud = await startFakeCloud();
  cloud.publish({ site: TEST_SITE, routing: { routes: {}, experiments: {} }, variants: {} });
});
afterAll(() => cloud.close());

const ENV = {
  EVOLVE_CLOUD_URL: "",
  EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV,
  EVOLVE_SECRET_KEY: TEST_SECRET_KEY,
  EVOLVE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
  EVOLVE_DATABASE_URL: "postgres://db",
  EVOLVE_TRACK_SECRET: "trk_x",
  VERCEL: "1",
};

/** An app `init` set up (static "/" and "/pricing"), so every check passes. */
async function healthy(extra: string[] = []): Promise<string> {
  const dir = freshApp({
    "app/pricing/page.tsx": "export default function P() {\n  return null;\n}\n",
  });
  const code = await initCommand(
    [
      "--key",
      TEST_SECRET_KEY,
      "--webhook-secret",
      TEST_WEBHOOK_SECRET,
      "--yes",
      "--routes",
      "/ /pricing",
      ...extra,
    ],
    {
      env: { EVOLVE_CLOUD_URL: cloud.url, EVOLVE_UNSAFE_TEST_PUBLIC_KEY: TEST_PUBLIC_KEY_ENV },
      cwd: dir,
      out: () => {},
      err: () => {},
      ask: null,
      setupDb: async () => ({ ok: true, applied: [] }),
      push: async () => 0,
      run: async () => 0,
    },
  );
  expect(code).toBe(0);
  return dir;
}

const CONFIG: EvolveConfig = {
  routes: { "/": { mode: "static" }, "/pricing": { mode: "static" } },
} as EvolveConfig;

/** Response headers the fake app (https://app.example.com) answers with (T23.4). */
let appHeaders: Record<string, string> = { server: "Vercel" };

/** The cloud's connection test answering "all good" (no real app to reach here). */
const testOk = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).startsWith("https://app.example.com/"))
    return new Response("ok", { headers: appHeaders });
  if (String(input).endsWith("/v1/site/test"))
    return Response.json({
      ok: true,
      webhook: { ok: true, detail: "HTTP 202" },
      aggregate: { ok: true, detail: "signed response verified" },
    });
  return fetch(input, init);
}) as typeof fetch;

function doctor(
  dir: string,
  over: Partial<DoctorDeps> = {},
  env: Record<string, string | undefined> = {},
) {
  return runDoctor({
    env: { ...ENV, EVOLVE_CLOUD_URL: cloud.url, ...env },
    cwd: dir,
    fetch: testOk,
    load: async () => ({ config: CONFIG }),
    checkDb: async () => ({ ok: true, pending: [] }),
    appUrl: "https://app.example.com",
    ...over,
  });
}
const by = (checks: Check[], name: string) => {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check "${name}" in ${checks.map((x) => x.name).join(", ")}`);
  return c;
};
const failing = (checks: Check[]) =>
  checks.filter((c) => c.status !== "ok").map((c) => `${c.status} ${c.name}: ${c.detail}`);

describe("next-evolve doctor (spec §16.2)", () => {
  it("a set-up app passes every check", async () => {
    const dir = await healthy();
    const checks = await doctor(dir);
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual([
      "Next.js",
      "Env vars",
      "Secret key",
      "Database",
      "Bundle",
      "Proxy matcher",
      "Pages",
      "EvolveScript",
      "Cloud → app",
      "CDN",
    ]);
  });

  it("each check catches its failing setup", async () => {
    const dir = await healthy();

    // Env vars: missing webhook secret fails, missing DB URL warns.
    let c = await doctor(
      dir,
      {},
      { EVOLVE_WEBHOOK_SECRET: undefined, EVOLVE_DATABASE_URL: undefined },
    );
    expect(by(c, "Env vars")).toMatchObject({ status: "fail" });
    expect(by(c, "Env vars").detail).toMatch(/EVOLVE_WEBHOOK_SECRET/);
    expect(by(c, "Database").status).toBe("warn");

    // Secret key the cloud rejects.
    c = await doctor(dir, {
      fetch: (async () => new Response('{"error":"invalid_key"}', { status: 401 })) as typeof fetch,
    });
    expect(by(c, "Secret key").status).toBe("fail");

    // DB unreachable, then reachable but not migrated.
    c = await doctor(dir, { checkDb: async () => ({ ok: false, error: "ECONNREFUSED" }) });
    expect(by(c, "Database")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/ECONNREFUSED/),
    });
    c = await doctor(dir, { checkDb: async () => ({ ok: true, pending: ["0002_x"] }) });
    expect(by(c, "Database")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/migrate/),
    });

    // Bundle expiring within 7 days (clock moved forward 10 days; bundles live 14).
    c = await doctor(dir, { now: () => Date.now() + 10 * 86_400_000 });
    expect(by(c, "Bundle")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/expires/),
    });

    // Matcher missing a route and /(ev_.*).
    writeFileSync(
      join(dir, "proxy.ts"),
      'import { createEvolveProxy } from "next-evolve/proxy";\nexport const proxy = createEvolveProxy({} as never);\nexport const config = { matcher: ["/"] };\n',
    );
    c = await doctor(dir);
    expect(by(c, "Proxy matcher")).toMatchObject({ status: "fail" });
    expect(by(c, "Proxy matcher").detail).toMatch(/\/pricing.*\/\(ev_\.\*\)/);
    // Patterns count: /:path* covers everything.
    writeFileSync(
      join(dir, "proxy.ts"),
      'import { createEvolveProxy } from "next-evolve/proxy";\nexport const proxy = createEvolveProxy({} as never);\nexport const config = { matcher: ["/:path*"] };\n',
    );
    expect(by(await doctor(dir), "Proxy matcher").status).toBe("ok");
    writeFileSync(join(dir, "proxy.ts"), "export function proxy() {}\n");
    expect(by(await doctor(dir), "Proxy matcher").detail).toMatch(/doesn't run Evolve/);
    rmSync(join(dir, "proxy.ts"));
    expect(by(await doctor(dir), "Proxy matcher").detail).toMatch(/no proxy/);

    // Pages: a static route whose page isn't wrapped; a root [slug] conflict.
    writeFileSync(
      join(dir, "app/[evolve]/pricing/page.tsx"),
      "export default function P() {\n  return null;\n}\n",
    );
    c = await doctor(dir);
    expect(by(c, "Pages")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/\/pricing.*withEvolve/),
    });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "app/[slug]"));
    writeFileSync(
      join(dir, "app/[slug]/page.tsx"),
      "export default function S() {\n  return null;\n}\n",
    );
    expect(by(await doctor(dir), "Pages").detail).toMatch(/\[slug\].*conflicts/);

    // EvolveScript missing from the root layout.
    writeFileSync(
      join(dir, "app/layout.tsx"),
      "export default function L({ children }) {\n  return children;\n}\n",
    );
    expect(by(await doctor(dir), "EvolveScript").status).toBe("fail");

    // cacheComponents is supported (T23.3): no warning under Next.js.
    writeFileSync(join(dir, "next.config.ts"), "export default { cacheComponents: true };\n");
    expect(by(await doctor(dir), "Next.js")).toMatchObject({ status: "ok" });

    // Cloud can't reach the app; no app URL yet only warns.
    c = await doctor(dir, { fetch: undefined });
    expect(by(c, "Cloud → app")).toMatchObject({ status: "fail" });
    c = await doctor(dir, { appUrl: null });
    expect(by(c, "Cloud → app")).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/connect --test --app-url/),
    });

    // Off Vercel: CDN warning.
    appHeaders = {};
    c = await doctor(dir, {}, { VERCEL: undefined });
    expect(by(c, "CDN")).toMatchObject({ status: "warn", detail: expect.stringMatching(/CDN/) });
    appHeaders = { server: "Vercel" };
  });

  it("CDN: detects Cloudflare and Netlify from the live site's headers (T23.4)", async () => {
    const dir = await healthy();
    const cdn = async (headers: Record<string, string>, env = { VERCEL: undefined }) => {
      appHeaders = headers;
      return by(await doctor(dir, {}, env), "CDN");
    };
    try {
      // The live site answers through Cloudflare: warn, with the guide.
      expect(await cdn({ server: "cloudflare", "cf-ray": "8f1-IAD" })).toMatchObject({
        status: "warn",
        detail: expect.stringMatching(
          /Cloudflare is in front of https:\/\/app\.example\.com.*\/, \/pricing.*hosting\.md#cloudflare/,
        ),
      });
      // cf-ray alone is enough; on Vercel behind Cloudflare it still warns.
      expect((await cdn({ "cf-ray": "x" }, { VERCEL: "1" } as never)).status).toBe("warn");
      // A tested route served from Cloudflare's cache: one variant for everyone.
      expect(
        await cdn({ server: "cloudflare", "cf-ray": "x", "cf-cache-status": "HIT" }),
      ).toMatchObject({ status: "fail", detail: expect.stringMatching(/cf-cache-status: HIT/) });
      expect((await cdn({ server: "cloudflare", "cf-cache-status": "DYNAMIC" })).status).toBe(
        "warn",
      );
      // Netlify: beta, unverified.
      expect(await cdn({ server: "Netlify", "x-nf-request-id": "01J" })).toMatchObject({
        status: "warn",
        detail: expect.stringMatching(/beta, not verified/),
      });
      // Vercel's headers count as Vercel even when doctor runs locally.
      expect(await cdn({ server: "Vercel", "x-vercel-id": "iad1::x" })).toMatchObject({
        status: "ok",
        detail: "Vercel",
      });
      // No CDN headers: the generic off-Vercel warning.
      expect((await cdn({ server: "nginx" })).detail).toMatch(/^not on Vercel/);
    } finally {
      appHeaders = { server: "Vercel" };
    }
  });

  it('cacheComponents + static mode: segment config fails, a "use cache" page passes (T23.3)', async () => {
    const dir = await healthy();
    writeFileSync(join(dir, "next.config.ts"), "export default { cacheComponents: true };\n");
    // init's classic static pages export revalidate/dynamicParams and don't cache themselves.
    let pages = by(await doctor(dir), "Pages");
    expect(pages.status).toBe("fail");
    expect(pages.detail).toMatch(
      /exports revalidate, dynamicParams, which cacheComponents rejects/,
    );
    expect(pages.detail).toMatch(/no "use cache"/);
    const cached = (path: string) => `import { cacheLife } from "next/cache";
import { type EvolvePageProps, evolveMetadata, evolveStaticParams, withEvolve } from "next-evolve";

export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("${path}");

const EvolvePage = withEvolve(() => null, { path: "${path}" });

export default async function Page({ params }: EvolvePageProps) {
  "use cache";
  cacheLife("hours");
  return <EvolvePage params={params} />;
}
`;
    writeFileSync(join(dir, "app/[evolve]/page.tsx"), cached("/"));
    pages = by(await doctor(dir), "Pages");
    expect(pages.detail).not.toMatch(/^\/:/);
    expect(pages.detail).toMatch(/\/pricing/);
    writeFileSync(join(dir, "app/[evolve]/pricing/page.tsx"), cached("/pricing"));
    const c = await doctor(dir);
    expect(by(c, "Pages")).toMatchObject({ status: "ok" });
    expect(by(c, "Next.js")).toMatchObject({ status: "ok" });
    // Without cacheComponents, the same pages are fine too.
    writeFileSync(join(dir, "next.config.ts"), "export default {};\n");
    expect(by(await doctor(dir), "Pages")).toMatchObject({ status: "ok" });
  });

  it("the command prints each check and exits 1 on a failure", async () => {
    const dir = await healthy();
    const { doctorCommand } = await import("./doctor");
    const lines: string[] = [];
    const deps = {
      env: { ...ENV, EVOLVE_CLOUD_URL: cloud.url },
      cwd: dir,
      fetch: testOk,
      load: async () => ({ config: CONFIG }),
      checkDb: async () => ({ ok: true as const, pending: [] }),
      appUrl: "https://app.example.com",
      out: (s: string) => lines.push(s),
      err: (s: string) => lines.push(s),
    };
    expect(await doctorCommand([], deps)).toBe(0);
    expect(lines.join("\n")).toContain("✓ Pages");
    lines.length = 0;
    const checkDb = vi.fn(async () => ({ ok: false as const, error: "down" }));
    expect(await doctorCommand([], { ...deps, checkDb })).toBe(1);
    expect(lines.join("\n")).toMatch(/✗ Database: down/);
  });

  it("cdnRouting: matcher literal must equal evolveMatcher(config), next.config must call evolveRewrites() (T19.5a)", async () => {
    const dir = await healthy(["--cdn-routing"]);
    const CDN = { ...CONFIG, cdnRouting: true } as EvolveConfig;
    const cdn = (over: Partial<DoctorDeps> = {}, env: Record<string, string | undefined> = {}) =>
      doctor(dir, { load: async () => ({ config: CDN }), ...over }, env);
    let c = await cdn();
    expect(failing(c)).toEqual([]);
    expect(by(c, "CDN routing")).toMatchObject({ status: "ok" });

    // A route added to evolve.config but not to the literal.
    const more = {
      ...CDN,
      routes: { ...CDN.routes, "/about": { mode: "static" } },
    } as EvolveConfig;
    c = await doctor(dir, { load: async () => ({ config: more }) });
    expect(by(c, "CDN routing")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/doesn't match evolveMatcher[\s\S]*\/about/),
    });

    // next.config without evolveRewrites(): a cookie would skip the proxy and 404.
    const nextFile = join(dir, "next.config.ts");
    writeFileSync(nextFile, "export default {};\n");
    c = await cdn();
    expect(by(c, "CDN routing")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/evolveRewrites/),
    });

    // cdnRouting turned off in evolve.config, proxy.ts still has the cookie matcher.
    c = await doctor(dir);
    expect(by(c, "CDN routing")).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/cdnRouting is off/),
    });

    // Off Vercel the CDN warning says why it matters more.
    appHeaders = {};
    c = await cdn({}, { VERCEL: undefined });
    appHeaders = { server: "Vercel" };
    expect(by(c, "CDN").detail).toMatch(/cdnRouting/);
  });

  it("without cdnRouting there is no CDN routing check", async () => {
    const c = await doctor(await healthy());
    expect(c.map((x) => x.name)).not.toContain("CDN routing");
  });
});
