const last = new Map<string, number>();

/** Logs at most once per `intervalMs` per key (default 60 s), so a hot path can't flood logs. */
export function logRateLimited(
  key: string,
  message: string,
  err?: unknown,
  intervalMs = 60_000,
): void {
  const now = Date.now();
  if ((last.get(key) ?? 0) + intervalMs > now) return;
  last.set(key, now);
  console.error(`[evolve] ${message}`, ...(err === undefined ? [] : [err]));
}
