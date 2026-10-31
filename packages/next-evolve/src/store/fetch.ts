export type FetchBundleResult =
  | { status: "ok"; token: string; etag: string | null }
  | { status: "not_modified" }
  | { status: "error"; code: number | "network"; message?: string };

/**
 * `GET {cloud}/v1/bundle` with the secret key and `If-None-Match` (spec §7.5).
 * Never throws. Verification is the caller's job.
 */
export async function fetchBundle(opts: {
  cloudUrl: string;
  secretKey: string;
  etag?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<FetchBundleResult> {
  const f = opts.fetch ?? fetch;
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
