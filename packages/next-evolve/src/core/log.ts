const last = new Map<string, number>();

/**
 * Logs at most once per `intervalMs` per key (default 60 s), so a hot path can't flood logs.
 * `level: "info"` is for normal states worth a line (stdout); hosts such as Vercel show
 * stderr lines as errors.
 */
export function logRateLimited(
  key: string,
  message: string,
  err?: unknown,
  intervalMs = 60_000,
  level: "error" | "info" = "error",
): void {
  const now = Date.now();
  if ((last.get(key) ?? 0) + intervalMs > now) return;
  last.set(key, now);
  const write = level === "info" ? console.info : console.error;
  write(`[evolve] ${message}`, ...(err === undefined ? [] : [err]));
}
