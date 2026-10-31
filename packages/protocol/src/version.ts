/** Highest protocol version (`pv`) this package defines. Equals the package's semver major. */
export const PROTOCOL_VERSION = 1 as const;
/** Every `pv` this package can read and write. */
export const SUPPORTED_PROTOCOLS: readonly number[] = Object.freeze([1]);

export function isSupportedProtocol(
  pv: unknown,
  supported: readonly number[] = SUPPORTED_PROTOCOLS,
): pv is number {
  return typeof pv === "number" && supported.includes(pv);
}

/** Highest version both sides support, or null if none. */
export function negotiateProtocol(a: readonly number[], b: readonly number[]): number | null {
  let best: number | null = null;
  for (const v of a) if (b.includes(v) && (best === null || v > best)) best = v;
  return best;
}

/**
 * Version the cloud emits for a site (spec §7.10): the cloud speaks its
 * current version N and N−1; pick the highest of those the site's SDK declared.
 * Null means the SDK is too old (the cloud stops publishing new bundles).
 */
export function cloudProtocolFor(
  cloudCurrent: number,
  siteSupported: readonly number[],
): number | null {
  return negotiateProtocol(
    [cloudCurrent, cloudCurrent - 1].filter((v) => v >= 1),
    siteSupported,
  );
}

/** Body of a `400` answer to a message with a `pv` this side doesn't speak. */
export function unsupportedProtocolBody(supported: readonly number[] = SUPPORTED_PROTOCOLS) {
  return { error: "unsupported_protocol" as const, supported: [...supported] };
}

export class UnsupportedProtocolError extends Error {
  constructor(
    readonly pv: unknown,
    readonly supported: readonly number[] = SUPPORTED_PROTOCOLS,
  ) {
    super(`unsupported protocol version ${String(pv)}; supported: ${supported.join(", ")}`);
    this.name = "UnsupportedProtocolError";
  }
}
