import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  BUNDLE_TTL_SECONDS,
  BUNDLE_TYP,
  type BundlePayload,
  computeBundleHash,
  type Manifest,
  manifestSchema,
  PROTOCOL_VERSION,
  parseSecretKey,
  type RegionRegistration,
  regionRegistrationSchema,
} from "@next-evolve/protocol";
import { signJws, type TestKeyPair } from "@next-evolve/protocol/testing";
import { TEST_KEY } from "./keys";

export * from "./keys";

/** What a test publishes: serving content only. The fake cloud fills pv, ver, iat, exp, hash. */
export type PublishInput = Pick<BundlePayload, "site" | "routing" | "variants"> & {
  ver?: number;
  /** Override timestamps (unix seconds), e.g. to publish an already-expired bundle. */
  iat?: number;
  exp?: number;
};

export type RecordedCall = { method: string; path: string; status: number; at: number };

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
  close(): Promise<void>;
};

type Stored = { token: string; payload: BundlePayload };

/**
 * Protocol-level mock of Evolve Cloud (no stats, no dashboard, no AI).
 * - `GET /v1/bundle` (bearer secret key, ETag `"<ver>.<iat>"`, 304 on match)
 * - `POST /__control/publish` (JSON {@link PublishInput}) → signed bundle
 * - `GET /__control/state` → recorded calls
 */
export async function startFakeCloud(
  opts: { port?: number; key?: TestKeyPair } = {},
): Promise<FakeCloud> {
  const key = opts.key ?? TEST_KEY;
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      calls.push({ method: req.method ?? "GET", path: url.pathname, status, at: Date.now() });
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

    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const site = auth ? parseSecretKey(auth[1]!)?.siteId : undefined;

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

    if (req.method === "GET" && url.pathname === "/v1/bundle") {
      if (!site) return send(401, { error: "invalid_key" });
      const stored = bundles.get(site);
      if (!stored) return send(404, { error: "no_bundle" });
      const etag = `"${stored.payload.ver}.${stored.payload.iat}"`;
      if (req.headers["if-none-match"] === etag) return send(304, undefined, { etag });
      return send(200, stored.token, { etag, "cache-control": "no-store" });
    }

    if (req.method === "POST" && url.pathname === "/__control/publish") {
      try {
        const out = publish(JSON.parse(await readBody(req)));
        return send(200, { ver: out.payload.ver, iat: out.payload.iat, token: out.token });
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
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
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
