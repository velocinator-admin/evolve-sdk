/** Highest protocol version (`pv`) this package defines. */
export const PROTOCOL_VERSION = 1 as const;
/** Every `pv` this package can read and write. */
export const SUPPORTED_PROTOCOLS: readonly number[] = Object.freeze([1]);
