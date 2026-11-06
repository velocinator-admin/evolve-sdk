import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type FetchBundleResult =
  | { status: "ok"; token: string; etag: string | null }
  | { status: "not_modified" }
  | { status: "error"; code: number | "network"; message?: string };

/** The cloud's answer for a deleted site (PRIV-1): 410 `{"error":"site_deleted"}`. */
export const isSiteDeleted = (res: FetchBundleResult): boolean =>
  res.status === "error" && res.code === 410 && (res.message ?? "").includes("site_deleted");

/**
 * `GET {cloud}/v1/bundle` with the secret key and `If-None-Match` (spec §7.5).
 * Never throws. Verification is the caller's job.
 *
 * Uses node:http(s) unless a `fetch` is injected (tests): the render path
 * refreshes through this too, and inside a static (ISR) render Next's patched
 * `fetch` turns an uncached call into "dynamic usage" and fails the page.
 */
export async function fetchBundle(opts: {
  cloudUrl: string;
  secretKey: string;
  etag?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<FetchBundleResult> {
  const f = opts.fetch ?? httpFetch;
  try {
    const res = await f(new URL("/v1/bundle", opts.cloudUrl), {
      headers: {
        authorization: `Bearer ${opts.secretKey}`,
        ...(opts.etag ? { "if-none-match": opts.etag } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    });
    if (res.status === 304) return { status: "not_modified" };
    if (!res.ok) {
      // Keep logs short: an error page can be a whole HTML document.
      const body = await res.text().catch(() => "");
      return { status: "error", code: res.status, message: body.slice(0, 200) };
    }
    return { status: "ok", token: (await res.text()).trim(), etag: res.headers.get("etag") };
  } catch (e) {
    return { status: "error", code: "network", message: String(e) };
  }
}

type MiniResponse = Pick<Response, "status" | "ok" | "text"> & {
  headers: { get(n: string): string | null };
};

/** A tiny GET over node:http(s) with fetch's shape (the parts fetchBundle uses). */
function httpFetch(
  url: URL,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<MiniResponse> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method: "GET", headers: init.headers, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: async () => body,
          headers: {
            get: (n: string) => {
              const v = res.headers[n.toLowerCase()];
              return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
            },
          },
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}
