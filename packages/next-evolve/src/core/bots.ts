import { isbot } from "isbot";

/** Unfurlers and tools `isbot` may not flag; all served control and never counted. */
const EXTRA = [
  /whatsapp/i,
  /telegrambot/i,
  /chrome-lighthouse/i,
  /headlesschrome/i,
  /vercelbot/i,
  /claude-user/i,
];

/**
 * Returns a detector: `isbot` + empty user agent + configured `extraPatterns`
 * (regex sources, case-insensitive). Bots get `ev_0` and no cookies.
 */
export function createBotDetector(
  extraPatterns: readonly string[] = [],
): (ua: string | null | undefined) => boolean {
  const extra = [...EXTRA, ...extraPatterns.map((p) => new RegExp(p, "i"))];
  return (ua) => {
    if (!ua?.trim()) return true;
    if (isbot(ua)) return true;
    for (const re of extra) if (re.test(ua)) return true;
    return false;
  };
}
