import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { DEFAULT_CLOUD_URL } from "../store/runtime";

type Env = Record<string, string | undefined>;

export type PushResult = { ok: true } | { ok: false; status: number | "network" | "no_key" };

/**
 * POSTs configuration (manifest, regions) to the cloud with the site's secret
 * key. Never throws and never blocks a request: callers run it in `after()`
 * or at startup. Without a secret key it's a no-op.
 *
 * Uses node:http, not `fetch`: Next patches `fetch` during prerender, and an
 * uncached fetch there counts as dynamic usage (the push would fail at build,
 * where static-mode regions are rendered).
 */
export function pushToCloud(
  path: "/v1/manifest" | "/v1/regions",
  body: unknown,
  opts: { env?: Env; timeoutMs?: number } = {},
): Promise<PushResult> {
  const env = opts.env ?? process.env;
  const key = env.EVOLVE_SECRET_KEY;
  const cloud = env.EVOLVE_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  if (!key || !cloud) return Promise.resolve({ ok: false, status: "no_key" });
  return new Promise((resolve) => {
    try {
      const url = new URL(path, cloud);
      const data = Buffer.from(JSON.stringify(body));
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "content-length": data.length,
          },
          timeout: opts.timeoutMs ?? 3000,
        },
        (res) => {
          res.resume(); // drain
          const status = res.statusCode ?? 0;
          resolve(status >= 200 && status < 300 ? { ok: true } : { ok: false, status });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => resolve({ ok: false, status: "network" }));
      req.end(data);
    } catch {
      resolve({ ok: false, status: "network" });
    }
  });
}
