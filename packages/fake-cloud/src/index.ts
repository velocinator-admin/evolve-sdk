import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AGGREGATE_PULL_PATH,
  type AggregateRequest,
  type AggregateResponse,
  aggregateRequestSchema,
  aggregateResponseSchema,
  BUNDLE_TTL_SECONDS,
  BUNDLE_TYP,
  type BundlePayload,
  computeBundleHash,
  DELIVERY_HEADER,
  type Manifest,
  manifestSchema,
  newRequestId,
  PREVIEW_TYP,
  PROTOCOL_VERSION,
  parseSecretKey,
  type RegionRegistration,
  regionRegistrationSchema,
  SIGNATURE_HEADER,
  signBody,
  verifyBody,
} from "@next-evolve/protocol";
import { signJws, type TestKeyPair } from "@next-evolve/protocol/testing";
import { TEST_KEY, TEST_SITE, TEST_WEBHOOK_SECRET } from "./keys";

export * from "./keys";

/** What a test publishes: serving content only. The fake cloud fills pv, ver, iat, exp, hash. */
export type PublishInput = Pick<BundlePayload, "site" | "routing" | "variants"> & {
  ver?: number;
  /** Override timestamps (unix seconds), e.g. to publish an already-expired bundle. */
  iat?: number;
  exp?: number;
};

export type RecordedCall = {
  method: string;
  path: string;
  status: number;
  at: number;
  /** Site of the bearer key, when there was one. */
  site?: string;
};

/** What a test asks the fake cloud to send; it fills type, pv, requestId and site. */
export type AggregateInput = Partial<AggregateRequest> &
  Pick<AggregateRequest, "experiments"> & { asOf?: string };

/** How `aggregate()` signs and delivers: defaults are a fresh delivery id and the current time. */
export type AggregateOptions = {
  site?: string;
  /** Reuse a delivery id (replay tests). */
  delivery?: string;
  /** Signature timestamp (unix seconds), e.g. stale. */
  t?: number;
};

/** One aggregate request the fake cloud sent to an app, and what came back. */
export type AggregateExchange = {
  request: AggregateRequest;
  status: number;
  /** True when the response carried a valid signature and matched the schema and request. */
  verified: boolean;
  response: AggregateResponse | null;
  body: unknown;
};

/** What a test asks the fake cloud to send to `<appUrl>/api/evolve/sync`. */
export type WebhookInput = {
  /** Defaults to `bundle.updated` for the site's current bundle. */
  body?: Record<string, unknown>;
  site?: string;
  /** Reuse a delivery id (replay tests). */
  delivery?: string;
  /** Signature timestamp (unix seconds), e.g. stale. */
  t?: number;
  /** Sign with another secret (forgery tests). */
  secret?: string;
};

/** One sync webhook the fake cloud sent. `status` 0 = unreachable. */
export type WebhookExchange = {
  appUrl: string;
  delivery: string;
  body: Record<string, unknown>;
  status: number;
  error?: string;
  at: number;
};

/** An upload (`POST /v1/aggregates`): the CLI's, or a pull-mode answer. */
export type AggregateUpload = {
  site: string;
  verified: boolean;
  response: AggregateResponse | null;
  /** True when it answers a request handed out by `GET /v1/aggregate-requests`. */
  pulled?: boolean;
};

/** A request queued for pull mode, and what happened to it. */
export type PulledExchange = {
  site: string;
  request: AggregateRequest;
  /** Times it was handed out (a lease that expired is handed out again). */
  leases: number;
  leasedUntil: number;
  answered: boolean;
};

export type FakeCloud = {
  url: string;
  key: TestKeyPair;
  /** Signs and stores a bundle for `input.site`. Returns the signed token and payload. */
  publish(input: PublishInput): { token: string; payload: BundlePayload };
  calls: RecordedCall[];
  /** Last manifest per site (POST /v1/manifest). */
  manifests: Map<string, Manifest>;
  /** Regions per site, keyed by region id (POST /v1/regions). */
  regions: Map<string, Map<string, RegionRegistration>>;
  /** Signs `input` with the site's webhook secret and POSTs it to `<appUrl>/api/evolve/aggregate`. */
  aggregate(
    appUrl: string,
    input: AggregateInput,
    opts?: AggregateOptions,
  ): Promise<AggregateExchange>;
  aggregates: AggregateExchange[];
  /** The next request handed to `next-evolve aggregate` (`POST /v1/aggregates/request`), per site. */
  setAggregateRequest(site: string, input: AggregateInput): void;
  uploads: AggregateUpload[];
  /**
   * Queues a request for pull mode: `GET /v1/aggregate-requests` hands it to
   * the site (signed like a push) until it's answered; a lease lasts
   * `leaseMs` (default 5 min), then it's handed out again.
   */
  queueAggregate(input: AggregateInput, opts?: { site?: string }): AggregateRequest;
  pulled: PulledExchange[];
  /** Signs a dashboard-style preview token that forces `code` on `site`. */
  preview(input: { site?: string; code: string; exp?: number }): string;
  /** Sites whose bearer requests get their connection dropped (cloud unreachable). */
  down: Set<string>;
  /** Deleted sites (PRIV-1): every bearer request gets 410 `{"error":"site_deleted"}`. */
  deleted: Set<string>;
  /** Sites whose key is rejected (revoked key, rotation): every bearer request gets 401 `invalid_key`. */
  rejected: Set<string>;
  /** Signs and POSTs a sync webhook to `<appUrl>/api/evolve/sync`; never throws. */
  webhook(appUrl: string, input?: WebhookInput): Promise<WebhookExchange>;
  webhooks: WebhookExchange[];
  /** App URL per site (`PUT /v1/site/app-url`). */
  appUrls: Map<string, string>;
  close(): Promise<void>;
};

type Stored = { token: string; payload: BundlePayload };

/**
 * Protocol-level mock of Evolve Cloud (no stats, no dashboard, no AI).
 * - `GET /v1/bundle` (bearer secret key, ETag `"<ver>.<iat>"`, 304 on match)
 * - `POST /__control/publish` (JSON {@link PublishInput} + optional `notify: appUrl`) → signed
 *   bundle, then a signed `bundle.updated` webhook to `notify`
 * - `POST /__control/webhook` ({ appUrl, ...{@link WebhookInput} }) → signed sync webhook
 * - `PUT /v1/site/app-url`, `GET /v1/site` (CLI)
 * - `GET /__control/state` → recorded calls
 * - `POST /__control/aggregate` ({ appUrl, site?, delivery?, t?, request }) → signed aggregate
 *   request to the app
 * - `POST /__control/preview` ({ site?, code, exp? }) → { token }: a signed preview token
 * - `POST /__control/outage` ({ site?, down }) → that site's bearer requests drop the connection
 * - `POST /__control/site` ({ site?, deleted?, rejected? }) → 410 site_deleted / 401 invalid_key for that site
 * - `POST /__control/aggregate-request` ({ site?, request }) → what `/v1/aggregates/request` returns
 * - `POST /v1/aggregates/request`, `POST /v1/aggregates` (CLI: fetch a request, upload its signed response)
 * - `GET /v1/aggregate-requests` (pull mode: leases queued requests, signed like a push)
 * - `POST /__control/aggregate-queue` ({ site?, request }) → queues a request for pull mode
 */
export async function startFakeCloud(
  opts: {
    port?: number;
    key?: TestKeyPair;
    webhookSecrets?: Record<string, string>;
    /** Sites that start out unreachable (see {@link FakeCloud.down}). */
    downSites?: string[];
    /** Pull-mode lease (ms). */
    leaseMs?: number;
  } = {},
): Promise<FakeCloud> {
  const down = new Set(opts.downSites ?? []);
  const deleted = new Set<string>();
  const rejected = new Set<string>();
  const key = opts.key ?? TEST_KEY;
  const secrets: Record<string, string> = {
    [TEST_SITE]: TEST_WEBHOOK_SECRET,
    ...opts.webhookSecrets,
  };
  const secretFor = (site: string) => secrets[site] ?? TEST_WEBHOOK_SECRET;
  const aggregates: AggregateExchange[] = [];
  const uploads: AggregateUpload[] = [];
  const pendingRequests = new Map<string, AggregateInput>();
  const pulled: PulledExchange[] = [];
  const leaseMs = opts.leaseMs ?? 300_000;
  const queueAggregate = (input: AggregateInput, o: { site?: string } = {}) => {
    const site = o.site ?? TEST_SITE;
    const request = fill(site, input);
    pulled.push({ site, request, leases: 0, leasedUntil: 0, answered: false });
    return request;
  };

  const fill = (site: string, input: AggregateInput): AggregateRequest =>
    aggregateRequestSchema.parse({
      type: "aggregate.request",
      pv: PROTOCOL_VERSION,
      requestId: newRequestId(),
      site,
      asOf: new Date(Date.now() - 120_000).toISOString(),
      mode: "incremental",
      usageFrom: null,
      ...input,
    }) as AggregateRequest;

  /** The response, if it's signed with the site's secret, valid, and answers `req`. */
  function checkResponse(
    site: string,
    text: string,
    signature: string | null,
    req?: AggregateRequest,
  ): AggregateResponse | null {
    if (!verifyBody(signature, text, secretFor(site)).ok) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const r = aggregateResponseSchema.safeParse(parsed);
    if (!r.success || r.data.site !== site) return null;
    if (req && (r.data.requestId !== req.requestId || r.data.asOf !== req.asOf)) return null;
    return r.data as AggregateResponse;
  }

  async function aggregate(
    appUrl: string,
    input: AggregateInput,
    o: AggregateOptions = {},
  ): Promise<AggregateExchange> {
    const site = o.site ?? TEST_SITE;
    const request = fill(site, input);
    const text = JSON.stringify(request);
    const res = await fetch(new URL("/api/evolve/aggregate", appUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signBody(secretFor(site), text, o.t),
        [DELIVERY_HEADER]: o.delivery ?? randomUUID(),
      },
      body: text,
    });
    const out = await res.text();
    let body: unknown = out;
    try {
      body = JSON.parse(out);
    } catch {}
    const response =
      res.status === 200
        ? checkResponse(site, out, res.headers.get(SIGNATURE_HEADER), request)
        : null;
    const exchange = { request, status: res.status, verified: response !== null, response, body };
    aggregates.push(exchange);
    return exchange;
  }
  const webhooks: WebhookExchange[] = [];
  const appUrls = new Map<string, string>();

  async function webhook(appUrl: string, input: WebhookInput = {}): Promise<WebhookExchange> {
    const site = input.site ?? TEST_SITE;
    const cur = bundles.get(site)?.payload;
    const body = input.body ?? {
      pv: PROTOCOL_VERSION,
      type: "bundle.updated",
      site,
      ver: cur?.ver ?? 0,
      iat: cur?.iat ?? Math.floor(Date.now() / 1000),
    };
    const text = JSON.stringify(body);
    const delivery = input.delivery ?? randomUUID();
    const x: WebhookExchange = { appUrl, delivery, body, status: 0, at: Date.now() };
    try {
      const res = await fetch(new URL("/api/evolve/sync", appUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signBody(input.secret ?? secretFor(site), text, input.t),
          [DELIVERY_HEADER]: delivery,
        },
        body: text,
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
      x.status = res.status;
    } catch (e) {
      x.error = String(e);
    }
    webhooks.push(x);
    return x;
  }

  const bundles = new Map<string, Stored>();
  const calls: RecordedCall[] = [];
  const manifests = new Map<string, Manifest>();
  const regions = new Map<string, Map<string, RegionRegistration>>();

  function publish(input: PublishInput): Stored {
    const prev = bundles.get(input.site)?.payload;
    const iat = input.iat ?? Math.floor(Date.now() / 1000);
    const content = { routing: input.routing, variants: input.variants };
    const payload: BundlePayload = {
      pv: PROTOCOL_VERSION,
      site: input.site,
      ver: input.ver ?? (prev ? prev.ver + 1 : 1),
      iat,
      exp: input.exp ?? iat + BUNDLE_TTL_SECONDS,
      hash: computeBundleHash(content),
      ...content,
    };
    const stored = { token: signJws(payload, { ...key, typ: BUNDLE_TYP }), payload };
    bundles.set(input.site, stored);
    return stored;
  }

  function preview(input: { site?: string; code: string; exp?: number }): string {
    const payload = {
      site: input.site ?? TEST_SITE,
      code: input.code,
      exp: input.exp ?? Math.floor(Date.now() / 1000) + 3600,
    };
    return signJws(payload, { ...key, typ: PREVIEW_TYP });
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const site = auth ? parseSecretKey(auth[1]!)?.siteId : undefined;
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      calls.push({
        method: req.method ?? "GET",
        path: url.pathname,
        status,
        at: Date.now(),
        ...(site ? { site } : {}),
      });
      const isText = typeof body === "string";
      res.writeHead(status, {
        ...(body === undefined
          ? {}
          : { "content-type": isText ? "application/jose" : "application/json" }),
        ...headers,
      });
      res.end(body === undefined ? undefined : isText ? body : JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true });

    // An unreachable cloud, as the app sees it: the connection drops, nothing is recorded.
    if (site && down.has(site)) {
      req.socket.destroy();
      return;
    }
    if (site && url.pathname.startsWith("/v1/")) {
      if (deleted.has(site)) return send(410, { error: "site_deleted" });
      if (rejected.has(site)) return send(401, { error: "invalid_key" });
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/v1/manifest" || url.pathname === "/v1/regions")
    ) {
      if (!site) return send(401, { error: "invalid_key" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(400, { error: "invalid_json" });
      }
      if (url.pathname === "/v1/manifest") {
        const m = manifestSchema.safeParse(body);
        if (!m.success) return send(400, { error: "invalid_manifest" });
        manifests.set(site, m.data);
      } else {
        const r = regionRegistrationSchema.safeParse(body);
        if (!r.success) return send(400, { error: "invalid_region" });
        const siteRegions = regions.get(site) ?? new Map<string, RegionRegistration>();
        siteRegions.set(r.data.id, r.data);
        regions.set(site, siteRegions);
      }
      return send(204);
    }

    if (req.method === "POST" && url.pathname === "/v1/aggregates/request") {
      if (!site) return send(401, { error: "invalid_key" });
      const input = pendingRequests.get(site);
      if (!input) return send(404, { error: "nothing_to_aggregate" });
      return send(200, { request: fill(site, input) });
    }

    if (req.method === "GET" && url.pathname === AGGREGATE_PULL_PATH) {
      if (!site) return send(401, { error: "invalid_key" });
      const now = Date.now();
      const due = pulled
        .filter((p) => p.site === site && !p.answered && p.leasedUntil <= now)
        .slice(0, 10);
      const requests = due.map((p) => {
        p.leases++;
        p.leasedUntil = now + leaseMs;
        const body = JSON.stringify(p.request);
        return { delivery: randomUUID(), signature: signBody(secretFor(site), body), body };
      });
      return send(200, { pv: PROTOCOL_VERSION, requests }, { "cache-control": "no-store" });
    }

    if (req.method === "POST" && url.pathname === "/v1/aggregates") {
      if (!site) return send(401, { error: "invalid_key" });
      const text = await readBody(req);
      let id: unknown;
      try {
        id = (JSON.parse(text) as { requestId?: unknown }).requestId;
      } catch {}
      // A pull answer must answer a request handed out to this very site.
      const issued = pulled.find((p) => p.request.requestId === id);
      if (issued && (issued.site !== site || issued.leases === 0)) {
        uploads.push({ site, verified: false, response: null, pulled: true });
        return send(404, { error: "unknown_request" });
      }
      if (issued?.answered) return send(409, { error: "already_stored" });
      const response = checkResponse(site, text, header(req, SIGNATURE_HEADER), issued?.request);
      uploads.push({
        site,
        verified: response !== null,
        response,
        ...(issued ? { pulled: true } : {}),
      });
      if (!response) return send(400, { error: "invalid_response" });
      if (issued) issued.answered = true;
      return send(200, { ok: true, rows: response.rows.length });
    }

    if (req.method === "POST" && url.pathname === "/__control/aggregate-queue") {
      try {
        const b = JSON.parse(await readBody(req)) as { site?: string; request: AggregateInput };
        return send(200, { request: queueAggregate(b.request, { site: b.site }) });
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/__control/aggregate") {
      try {
        const b = JSON.parse(await readBody(req)) as AggregateOptions & {
          appUrl: string;
          request: AggregateInput;
        };
        const { appUrl, request, ...o } = b;
        return send(200, await aggregate(appUrl, request, o));
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/__control/aggregate-request") {
      try {
        const b = JSON.parse(await readBody(req)) as { site?: string; request: AggregateInput };
        const s = b.site ?? TEST_SITE;
        fill(s, b.request); // validate now
        pendingRequests.set(s, b.request);
        return send(204);
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/v1/bundle") {
      if (!site) return send(401, { error: "invalid_key" });
      const stored = bundles.get(site);
      if (!stored) return send(404, { error: "no_bundle" });
      const etag = `"${stored.payload.ver}.${stored.payload.iat}"`;
      if (req.headers["if-none-match"] === etag) return send(304, undefined, { etag });
      return send(200, stored.token, { etag, "cache-control": "no-store" });
    }

    if (req.method === "POST" && url.pathname === "/__control/publish") {
      let out: Stored;
      let notify: string | undefined;
      try {
        const b = JSON.parse(await readBody(req)) as PublishInput & { notify?: string };
        notify = b.notify;
        out = publish(b);
      } catch (e) {
        return send(400, { error: String(e) });
      }
      const sent = notify ? await webhook(notify, { site: out.payload.site }) : undefined;
      return send(200, {
        ver: out.payload.ver,
        iat: out.payload.iat,
        token: out.token,
        ...(sent ? { webhook: sent } : {}),
      });
    }

    if (req.method === "POST" && url.pathname === "/__control/webhook") {
      try {
        const b = JSON.parse(await readBody(req)) as WebhookInput & { appUrl: string };
        return send(200, await webhook(b.appUrl, b));
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (url.pathname === "/v1/site" && req.method === "GET") {
      if (!site) return send(401, { error: "invalid_key" });
      return send(200, { site, name: "Fake site", appUrl: appUrls.get(site) ?? null });
    }

    if (url.pathname === "/v1/site/test" && req.method === "POST") {
      if (!site) return send(401, { error: "invalid_key" });
      const appUrl = appUrls.get(site) ?? manifests.get(site)?.appUrl ?? null;
      if (!appUrl) {
        const none = { ok: false, detail: "no app URL yet" };
        return send(200, { ok: false, webhook: none, aggregate: none });
      }
      const hook = await webhook(appUrl, { site, body: { pv: PROTOCOL_VERSION, type: "ping" } });
      const agg = await aggregate(appUrl, { experiments: [] }, { site }).catch(() => null);
      const webhookResult =
        hook.status >= 200 && hook.status < 300
          ? { ok: true, detail: `HTTP ${hook.status}` }
          : { ok: false, detail: hook.error ? "unreachable" : `HTTP ${hook.status}` };
      const aggregateResult = agg?.verified
        ? { ok: true, detail: "signed response verified" }
        : { ok: false, detail: agg ? `HTTP ${agg.status}` : "unreachable" };
      return send(200, {
        ok: webhookResult.ok && aggregateResult.ok,
        webhook: webhookResult,
        aggregate: aggregateResult,
      });
    }

    if (url.pathname === "/v1/site/app-url" && req.method === "PUT") {
      if (!site) return send(401, { error: "invalid_key" });
      try {
        const b = JSON.parse(await readBody(req)) as { appUrl?: string };
        const u = new URL(b.appUrl ?? "");
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
        appUrls.set(site, u.origin);
        return send(200, { appUrl: u.origin });
      } catch {
        return send(400, { error: "invalid_app_url" });
      }
    }

    if (req.method === "POST" && url.pathname === "/__control/preview") {
      try {
        const b = JSON.parse(await readBody(req)) as { site?: string; code: string; exp?: number };
        return send(200, { token: preview(b) });
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/__control/site") {
      try {
        const b = JSON.parse(await readBody(req)) as {
          site?: string;
          deleted?: boolean;
          rejected?: boolean;
        };
        const s = b.site ?? TEST_SITE;
        if (b.deleted !== undefined) b.deleted ? deleted.add(s) : deleted.delete(s);
        if (b.rejected !== undefined) b.rejected ? rejected.add(s) : rejected.delete(s);
        return send(200, { deleted: [...deleted], rejected: [...rejected] });
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (req.method === "POST" && url.pathname === "/__control/outage") {
      try {
        const b = JSON.parse(await readBody(req)) as { site?: string; down: boolean };
        const s = b.site ?? TEST_SITE;
        if (b.down) down.add(s);
        else down.delete(s);
        return send(200, { down: [...down] });
      } catch (e) {
        return send(400, { error: String(e) });
      }
    }

    if (req.method === "GET" && url.pathname === "/__control/state") {
      return send(200, {
        calls,
        sites: [...bundles.keys()],
        manifests: Object.fromEntries(manifests),
        regions: Object.fromEntries([...regions].map(([k, v]) => [k, Object.fromEntries(v)])),
        aggregates,
        uploads,
        pulled,
        webhooks,
        appUrls: Object.fromEntries(appUrls),
      });
    }

    send(404, { error: "not_found" });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500).end(String(e));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    url: `http://127.0.0.1:${port}`,
    key,
    publish,
    calls,
    manifests,
    regions,
    aggregate,
    aggregates,
    setAggregateRequest: (site, input) => {
      fill(site, input);
      pendingRequests.set(site, input);
    },
    uploads,
    queueAggregate,
    pulled,
    preview,
    down,
    deleted,
    rejected,
    webhook,
    webhooks,
    appUrls,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
