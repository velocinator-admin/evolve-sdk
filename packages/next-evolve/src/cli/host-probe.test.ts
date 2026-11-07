import { describe, expect, it } from "vitest";
import { hostFromHeaders, probeHost } from "./host-probe";

const h = (o: Record<string, string>) => new Headers(o);

describe("hostFromHeaders (T23.4)", () => {
  it("Cloudflare by cf-ray or server; cache HIT/STALE counts as cached", () => {
    expect(hostFromHeaders(h({ "cf-ray": "8f-IAD" }))).toEqual({
      host: "cloudflare",
      cacheHit: false,
    });
    expect(hostFromHeaders(h({ server: "cloudflare", "cf-cache-status": "HIT" })).cacheHit).toBe(
      true,
    );
    expect(hostFromHeaders(h({ server: "cloudflare", "cf-cache-status": "STALE" })).cacheHit).toBe(
      true,
    );
    expect(hostFromHeaders(h({ server: "cloudflare", "cf-cache-status": "BYPASS" })).cacheHit).toBe(
      false,
    );
  });
  it("Netlify, Vercel, or nothing", () => {
    expect(hostFromHeaders(h({ "x-nf-request-id": "01J" })).host).toBe("netlify");
    expect(
      hostFromHeaders(h({ server: "Netlify", "cache-status": '"Netlify Edge"; hit' })).cacheHit,
    ).toBe(true);
    expect(
      hostFromHeaders(h({ server: "Netlify", "cache-status": '"Netlify Edge"; fwd=miss' }))
        .cacheHit,
    ).toBe(false);
    expect(hostFromHeaders(h({ server: "Vercel", "x-vercel-cache": "HIT" }))).toEqual({
      host: "vercel",
      cacheHit: true,
    });
    expect(hostFromHeaders(h({ server: "nginx" }))).toEqual({ host: null, cacheHit: false });
  });
});

describe("probeHost", () => {
  it("GETs the route on the app URL without cookies; unreachable → null", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const f = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response("x", { headers: { "cf-ray": "1" } });
    }) as unknown as typeof fetch;
    expect(await probeHost("https://shop.example.com", "/pricing", f)).toEqual({
      host: "cloudflare",
      cacheHit: false,
      url: "https://shop.example.com/pricing",
    });
    expect(seen!.init?.headers).not.toHaveProperty("cookie");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await probeHost("https://shop.example.com", "/", down)).toBeNull();
  });
});
