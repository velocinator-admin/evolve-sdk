// The CLI's calls to Evolve Cloud (spec §11): connection check, app URL,
// connection test. Plain fetch (the CLI runs outside Next).
import { DEFAULT_CLOUD_URL } from "../store/runtime";

type Env = Record<string, string | undefined>;

export type CloudDeps = { env: Env; fetch?: typeof fetch };

export type SiteInfo = { id: string; name: string; appUrl: string | null };

export const cloudUrl = (env: Env): string => env.EVOLVE_CLOUD_URL ?? DEFAULT_CLOUD_URL!;

async function call(
  deps: CloudDeps,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<
  { ok: true; status: number; json: unknown } | { ok: false; error: string; status?: number }
> {
  try {
    const res = await (deps.fetch ?? fetch)(new URL(path, cloudUrl(deps.env)), {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const err = (json as { error?: string; message?: string } | null) ?? {};
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 401
            ? "the secret key was rejected (check EVOLVE_SECRET_KEY)"
            : res.status === 410 && err.error === "site_deleted"
              ? "this site was deleted in Evolve Cloud"
              : `HTTP ${res.status}${err.message ? `: ${err.message}` : err.error ? `: ${err.error}` : ""}`,
      };
    }
    return { ok: true, status: res.status, json };
  } catch (e) {
    return {
      ok: false,
      error: `can't reach ${cloudUrl(deps.env)} (${e instanceof Error ? e.message : e})`,
    };
  }
}

/** `GET /v1/site`: which site this key belongs to. Accepts the cloud's and the fake cloud's shapes. */
export async function getSiteInfo(
  deps: CloudDeps,
  key: string,
): Promise<{ ok: true; site: SiteInfo } | { ok: false; error: string }> {
  const r = await call(deps, key, "GET", "/v1/site");
  if (!r.ok) return r;
  const j = r.json as { site?: unknown; name?: string; appUrl?: string | null };
  const s =
    j.site && typeof j.site === "object"
      ? (j.site as SiteInfo)
      : { id: String(j.site ?? ""), name: j.name ?? "", appUrl: j.appUrl ?? null };
  return { ok: true, site: s };
}

/** `PUT /v1/site/app-url`. */
export async function putAppUrl(
  deps: CloudDeps,
  key: string,
  appUrl: string,
): Promise<{ ok: true; appUrl: string } | { ok: false; error: string }> {
  const r = await call(deps, key, "PUT", "/v1/site/app-url", { appUrl });
  if (!r.ok) return r;
  return { ok: true, appUrl: (r.json as { appUrl: string }).appUrl };
}

export type CheckResult = { ok: boolean; detail?: string };

/** `POST /v1/site/test`: the cloud pings the sync route and dry-runs an aggregate. */
export async function runCloudTest(
  deps: CloudDeps,
  key: string,
): Promise<
  { ok: true; webhook: CheckResult; aggregate: CheckResult } | { ok: false; error: string }
> {
  const r = await call(deps, key, "POST", "/v1/site/test");
  if (!r.ok) return r;
  const j = r.json as { webhook: CheckResult; aggregate: CheckResult };
  return { ok: true, webhook: j.webhook, aggregate: j.aggregate };
}
