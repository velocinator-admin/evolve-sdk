import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted (by UTF-16 code unit), no whitespace,
 * `undefined` object values omitted. Throws on NaN, Infinity, functions,
 * symbols, bigints and `undefined` array items.
 */
export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v
          .map((item) => {
            if (item === undefined) throw new TypeError("canonicalJson: undefined array item");
            return write(item);
          })
          .join(",")}]`;
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
