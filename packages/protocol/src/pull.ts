import { z } from "zod";

/**
 * Pull mode (protocol 1.2.0, AGG-2): an app the cloud can't reach polls
 * `GET /v1/aggregate-requests` with its secret key. Each request is signed
 * exactly like a push (`body` is the raw JSON the cloud would POST to
 * `/api/evolve/aggregate`, `signature` its `Evolve-Signature`, `delivery` its
 * `Evolve-Delivery`). The app answers each with `POST /v1/aggregates`, signed
 * like a route response.
 */
export const AGGREGATE_PULL_PATH = "/v1/aggregate-requests";
/** Where pulled results (and CLI uploads) go. */
export const AGGREGATE_UPLOAD_PATH = "/v1/aggregates";
/** How often the app polls, in seconds. */
export const PULL_INTERVAL_SECONDS = 60;
/** Most requests one poll hands out. */
export const MAX_PULL_REQUESTS = 10;

export const pulledRequestSchema = z.looseObject({
  delivery: z.string().min(1).max(128),
  signature: z.string().min(1).max(512),
  body: z
    .string()
    .min(2)
    .max(256 * 1024),
});
export type PulledRequest = z.infer<typeof pulledRequestSchema>;

/** `GET /v1/aggregate-requests` answer. Empty `requests` = nothing to do. */
export const aggregatePullSchema = z.looseObject({
  pv: z.number().int().positive(),
  requests: z.array(pulledRequestSchema).max(MAX_PULL_REQUESTS),
});
export type AggregatePull = z.infer<typeof aggregatePullSchema>;
