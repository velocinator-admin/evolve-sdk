import { z } from "zod";
import { CODE_RE } from "./code";
import { SITE_ID_RE } from "./ids";
import { type KeyRing, verifyJws } from "./jws";
import { PREVIEW_TYP } from "./keys";

/** Preview token payload (spec §7.2): signed by the cloud with the bundle key, `exp` = now + 1 h. */
export const previewPayloadSchema = z.looseObject({
  site: z.string().regex(SITE_ID_RE),
  code: z.string().regex(CODE_RE),
  exp: z.number().int().positive(),
});
export type PreviewPayload = z.infer<typeof previewPayloadSchema>;

/** Returns the payload of a valid, unexpired preview token for `site`, else null. */
export function verifyPreview(
  token: string,
  opts: { keys: KeyRing; site: string; now?: number },
): PreviewPayload | null {
  if (token.length > 2048) return null;
  const jws = verifyJws(token, opts.keys, PREVIEW_TYP);
  if (!jws.ok) return null;
  const p = previewPayloadSchema.safeParse(jws.payload);
  if (!p.success || p.data.site !== opts.site) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  return now < p.data.exp ? p.data : null;
}
