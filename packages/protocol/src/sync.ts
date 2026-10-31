import { z } from "zod";
import { SITE_ID_RE } from "./ids";

/** Body of `POST <appUrl>/api/evolve/sync` (spec §7.6). Carries no config: the app pulls the signed bundle. */
export const syncWebhookSchema = z.discriminatedUnion("type", [
  z.looseObject({
    pv: z.number().int().positive(),
    type: z.literal("bundle.updated"),
    site: z.string().regex(SITE_ID_RE),
    ver: z.number().int().nonnegative(),
    iat: z.number().int().positive(),
  }),
  z.looseObject({ pv: z.number().int().positive(), type: z.literal("ping") }),
]);
export type SyncWebhook = z.infer<typeof syncWebhookSchema>;
