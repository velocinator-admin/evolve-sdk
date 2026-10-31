import { TEST_KEY, TEST_SITE } from "@next-evolve/fake-cloud";
import {
  BUNDLE_TYP,
  type BundlePayload,
  computeBundleHash,
  createKeyRing,
} from "@next-evolve/protocol";
import { signJws } from "@next-evolve/protocol/testing";
import { NextRequest } from "next/server";
import { createMemoryStore } from "../src/store/memory";
import { sampleBundle } from "./samples";

export const keys = createKeyRing({ [TEST_KEY.kid]: TEST_KEY.publicKey });

export function signBundle(b: BundlePayload): string {
  const payload = { ...b, site: TEST_SITE, hash: computeBundleHash(b) };
  return signJws(payload, { ...TEST_KEY, typ: BUNDLE_TYP });
}

/** Static store holding `sampleBundle()` (optionally mutated) for TEST_SITE. */
export function storeWith(mutate?: (b: BundlePayload) => void) {
  return createMemoryStore({
    site: TEST_SITE,
    keys,
    pollMs: 60_000,
    initialToken: signBundle(sampleBundle(mutate)),
  });
}

export const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export function request(
  path: string,
  opts: {
    ua?: string | null;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers(opts.headers);
  if (opts.ua !== null) headers.set("user-agent", opts.ua ?? CHROME);
  if (opts.cookies) {
    headers.set(
      "cookie",
      Object.entries(opts.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  return new NextRequest(new URL(path, "https://acme.test"), { headers });
}
