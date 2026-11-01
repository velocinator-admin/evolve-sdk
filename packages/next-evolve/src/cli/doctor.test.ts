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
async function healthy(): Promise<string> {
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

/** The cloud's connection test answering "all good" (no real app to reach here). */
const testOk = (async (input: RequestInfo | URL, init?: RequestInit) => {
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

    // cacheComponents → warn under Next.js.
    writeFileSync(join(dir, "next.config.ts"), "export default { cacheComponents: true };\n");
    expect(by(await doctor(dir), "Next.js")).toMatchObject({ status: "warn" });

    // Cloud can't reach the app; no app URL yet only warns.
    c = await doctor(dir, { fetch: undefined });
    expect(by(c, "Cloud → app")).toMatchObject({ status: "fail" });
    c = await doctor(dir, { appUrl: null });
    expect(by(c, "Cloud → app")).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/connect --test --app-url/),
    });

    // Off Vercel: CDN warning.
    c = await doctor(dir, {}, { VERCEL: undefined });
    expect(by(c, "CDN")).toMatchObject({ status: "warn", detail: expect.stringMatching(/CDN/) });
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
});
