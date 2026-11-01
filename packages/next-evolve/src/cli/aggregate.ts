// `next-evolve aggregate [--upload]` (spec §9.8): runs the cloud's aggregate
// request against your local DB, for local dev where the cloud can't reach
// localhost. Prints the sufficient statistics; `--upload` sends them to the
// cloud (POST /v1/aggregates, signed with EVOLVE_WEBHOOK_SECRET).
import {
  type AggregateRequest,
  aggregateRequestSchema,
  isSupportedProtocol,
  parseSecretKey,
  SIGNATURE_HEADER,
  signBody,
} from "@next-evolve/protocol";
import { runAggregate } from "../aggregate/run";
import { sdkVersion } from "../cloud/manifest";
import { createSql } from "../db/client";
import { DEFAULT_CLOUD_URL } from "../store/runtime";

type Env = Record<string, string | undefined>;

export type AggregateCommandDeps = {
  env: Env;
  fetch?: typeof fetch;
  out?: (s: string) => void;
  err?: (s: string) => void;
};

export async function aggregateCommand(
  args: string[],
  deps: AggregateCommandDeps,
): Promise<number> {
  const { env } = deps;
  const out = deps.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = deps.err ?? ((s) => console.error(s));
  const doFetch = deps.fetch ?? fetch;
  const upload = args.includes("--upload");

  const key = env.EVOLVE_SECRET_KEY;
  const secret = env.EVOLVE_WEBHOOK_SECRET;
  const dbUrl = env.EVOLVE_DATABASE_URL;
  const site = parseSecretKey(key ?? "")?.siteId;
  const missing = [
    !site && "EVOLVE_SECRET_KEY",
    !dbUrl && "EVOLVE_DATABASE_URL",
    upload && !secret && "EVOLVE_WEBHOOK_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    err(`next-evolve aggregate: set ${missing.join(", ")}`);
    return 1;
  }
  const cloud = env.EVOLVE_CLOUD_URL ?? DEFAULT_CLOUD_URL;
  const auth = { authorization: `Bearer ${key}` };

  // 1. The cloud decides what to aggregate (experiments, goals, watermarks).
  let request: AggregateRequest;
  try {
    const res = await doFetch(new URL("/v1/aggregates/request", cloud), {
      method: "POST",
      headers: auth,
    });
    if (res.status === 404) {
      out("Nothing to aggregate: no running experiments.");
      return 0;
    }
    if (!res.ok) {
      err(`next-evolve aggregate: the cloud answered ${res.status} for the request`);
      return 1;
    }
    const body = (await res.json()) as { request?: { pv?: unknown } };
    if (!isSupportedProtocol(body.request?.pv)) {
      err("next-evolve aggregate: unsupported protocol version; upgrade next-evolve");
      return 1;
    }
    const parsed = aggregateRequestSchema.safeParse(body.request);
    if (!parsed.success || parsed.data.site !== site) {
      err("next-evolve aggregate: the cloud sent an invalid request");
      return 1;
    }
    request = parsed.data;
  } catch (e) {
    err(`next-evolve aggregate: can't reach ${cloud} (${e instanceof Error ? e.message : e})`);
    return 1;
  }

  // 2. Run it locally. The CLI isn't bound by a function time limit.
  const sql = createSql(dbUrl!, { max: 1 });
  let result: Awaited<ReturnType<typeof runAggregate>>;
  try {
    result = await runAggregate(sql, request, {
      maxMs: 120_000,
      statementTimeoutMs: 60_000,
      sdkVersion: sdkVersion(),
    });
  } catch (e) {
    err(`next-evolve aggregate: database error (${e instanceof Error ? e.message : e})`);
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (result.kind === "busy") {
    err("next-evolve aggregate: another aggregation is running; try again in 30 s");
    return 1;
  }
  const r = result.response;
  const summary = `${r.rows.length} rows for ${request.experiments.length} experiment(s) in ${r.durationMs} ms${
    r.partial ? `, partial (remaining: ${r.remaining.join(", ")})` : ""
  }${r.errors.length ? `, ${r.errors.length} error(s)` : ""}`;

  if (!upload) {
    out(JSON.stringify(r, null, 2));
    err(summary);
    return 0;
  }

  // 3. Upload, signed like a route response.
  const body = JSON.stringify(r);
  try {
    const res = await doFetch(new URL("/v1/aggregates", cloud), {
      method: "POST",
      headers: {
        ...auth,
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signBody(secret!, body),
      },
      body,
    });
    if (!res.ok) {
      err(`next-evolve aggregate: upload failed (${res.status} ${await res.text()})`);
      return 1;
    }
  } catch (e) {
    err(`next-evolve aggregate: upload failed (${e instanceof Error ? e.message : e})`);
    return 1;
  }
  out(`Uploaded ${summary}.`);
  return 0;
}
