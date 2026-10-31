import { cache } from "react";

export type EvolveRequestContext = { code: string | null; path: string | null };

/** Per-request store (React `cache()`), filled by `withEvolve` before the page body renders. */
export const requestContext = cache((): EvolveRequestContext => ({ code: null, path: null }));
