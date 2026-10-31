import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Goals } from "../config/goals";
import type { Writer } from "../db/writer";
import { eventRow } from "./events";

export const MAX_TRACK_EVENTS = 500;

const trackEvent = z.object({
  name: z.string().min(1).max(100),
  userId: z.string().max(256).nullish(),
  anonId: z.string().max(64).nullish(),
  value: z.number().finite().nullish(),
  props: z.record(z.string(), z.unknown()).nullish(),
  source: z.string().max(64).optional(),
  ts: z.union([z.string(), z.number()]).optional(),
  dedupeKey: z.string().max(200).nullish(),
});
export const trackBodySchema = z.object({
  events: z.array(trackEvent).min(1).max(MAX_TRACK_EVENTS),
});

function bearerOk(req: Request, secret: string): boolean {
  const h = req.headers.get("authorization") ?? "";
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * `POST /api/evolve/track`: server-to-server events (Segment, a CRM, a
 * webhook relay) with `Authorization: Bearer $EVOLVE_TRACK_SECRET`.
 */
export async function handleTrack(
  req: Request,
  deps: { secret: string | undefined; goals: Goals | undefined; writer: Writer },
): Promise<Response> {
  if (!deps.secret) return Response.json({ error: "track_disabled" }, { status: 404 });
  if (!bearerOk(req, deps.secret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: z.infer<typeof trackBodySchema>;
  try {
    const r = trackBodySchema.safeParse(await req.json());
    if (!r.success) {
      return Response.json(
        { error: "invalid_body", issues: r.error.issues.slice(0, 5) },
        { status: 400 },
      );
    }
    body = r.data;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const rows = body.events.flatMap((e) => {
    const row = eventRow(e.name, e, deps.goals, "webhook");
    return row ? [row] : [];
  });
  deps.writer.events(rows);
  // Webhook senders retry on failure, so write before answering.
  await deps.writer.flush();
  return Response.json({ accepted: rows.length });
}
