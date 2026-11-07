import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = { code: null as string | null, path: null as string | null };
vi.mock("./context", () => ({ requestContext: () => ctx }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const { withEvolve, evolveStaticParams, evolveMetadata } = await import("./with-evolve");

const params = (evolve: string) => ({ params: Promise.resolve({ evolve }) });
function Home(_p: object) {
  return null;
}

beforeEach(() => {
  ctx.code = null;
  ctx.path = null;
});

describe("withEvolve", () => {
  it("sets the request context and renders the page", async () => {
    const Page = withEvolve(Home, { path: "/pricing/" });
    const el = (await Page(params("ev_k3j9x2-c1d2e3"))) as ReactElement;
    expect(el.type).toBe(Home);
    expect(ctx).toEqual({ code: "ev_k3j9x2-c1d2e3", path: "/pricing", vars: {} });
  });

  it("keeps the page's route params for {var} placeholders (TPL-1.2)", async () => {
    const Page = withEvolve(Home, { path: "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)" });
    await Page({ params: Promise.resolve({ evolve: "ev_0", name: "Christopher-G" }) } as never);
    expect(ctx).toMatchObject({
      path: "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)",
      vars: { name: "Christopher-G" },
    });
  });

  it("404s on a malformed code", async () => {
    const Page = withEvolve(Home, { path: "/" });
    await expect(Page(params("ev_bad"))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(Page(params("pricing"))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("evolveStaticParams", () => {
  it("prerenders control only", () => {
    expect(evolveStaticParams()).toEqual([{ evolve: "ev_0" }]);
  });
});

describe("evolveMetadata", () => {
  it("sets canonical to the original path; noindex on variants", async () => {
    const gen = evolveMetadata("/", { title: "Acme", alternates: { languages: { de: "/de" } } });
    expect(await gen(params("ev_0"))).toEqual({
      title: "Acme",
      alternates: { languages: { de: "/de" }, canonical: "/" },
    });
    expect(await gen(params("ev_k3j9x2-c1d2e3"))).toMatchObject({
      title: "Acme",
      alternates: { canonical: "/" },
      robots: { index: false, follow: true },
    });
  });

  it("accepts a metadata function", async () => {
    const gen = evolveMetadata("/pricing", async () => ({ title: "Pricing" }));
    expect(await gen(params("ev_0"))).toEqual({
      title: "Pricing",
      alternates: { canonical: "/pricing" },
    });
  });

  it("a pattern route's canonical is the page's own path (D77)", async () => {
    const lp = evolveMetadata("/lp/:slug");
    const at = (p: Record<string, string | string[]>) =>
      lp({ params: Promise.resolve({ evolve: "ev_0", ...p }) });
    expect((await at({ slug: "spring sale" })).alternates?.canonical).toBe("/lp/spring%20sale");
    const docs = evolveMetadata("/docs/:path*");
    const d = (p: Record<string, string | string[]>) =>
      docs({ params: Promise.resolve({ evolve: "ev_0", ...p }) });
    expect((await d({ path: ["a", "b"] })).alternates?.canonical).toBe("/docs/a/b");
    expect((await d({})).alternates?.canonical).toBe("/docs");
  });
});
