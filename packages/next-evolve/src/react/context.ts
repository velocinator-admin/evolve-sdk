import { cache } from "react";

export type EvolveRequestContext = {
  code: string | null;
  path: string | null;
  /** Static mode: the page's route params (decoded), for `{var}` placeholders (TPL-1.2). */
  vars: Record<string, string> | null;
};

/** Per-request store (React `cache()`), filled by `withEvolve` before the page body renders. */
export const requestContext = cache(
  (): EvolveRequestContext => ({ code: null, path: null, vars: null }),
);
