// T23.4 (HOST-1): `doctor` asks the live site who serves it, from its response
// headers. Cloudflare in front of an app can cache one variant for everyone;
// Netlify isn't verified yet.

export type HostProbe = {
  /** Who answered: the CDN/host the headers name, or null when they name none. */
  host: "cloudflare" | "netlify" | "vercel" | null;
  /** The CDN says it served this response from its cache. */
  cacheHit: boolean;
  url: string;
};

const HUMAN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 next-evolve-doctor";

/** Reads the host from response headers (exported for tests). */
export function hostFromHeaders(h: Headers): Omit<HostProbe, "url"> {
  const server = (h.get("server") ?? "").toLowerCase();
  if (h.has("cf-ray") || server.includes("cloudflare")) {
    const status = (h.get("cf-cache-status") ?? "").toUpperCase();
    return { host: "cloudflare", cacheHit: status === "HIT" || status === "STALE" };
  }
  if (h.has("x-nf-request-id") || server.includes("netlify")) {
    const cache = (h.get("cache-status") ?? "").toLowerCase();
    return { host: "netlify", cacheHit: /\bhit\b/.test(cache) && !/fwd=miss/.test(cache) };
  }
  if (h.has("x-vercel-id") || server.includes("vercel"))
    return { host: "vercel", cacheHit: (h.get("x-vercel-cache") ?? "") === "HIT" };
  return { host: null, cacheHit: false };
}

/** GET `path` on the app (as a browser would, no cookies); null when it can't be reached. */
export async function probeHost(
  appUrl: string,
  path: string,
  f: typeof fetch = fetch,
): Promise<HostProbe | null> {
  const url = new URL(path, appUrl).toString();
  try {
    const res = await f(url, {
      headers: { "user-agent": HUMAN_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel().catch(() => {});
    return { ...hostFromHeaders(res.headers), url };
  } catch {
    return null;
  }
}
