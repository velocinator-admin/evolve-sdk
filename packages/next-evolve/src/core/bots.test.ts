import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createBotDetector } from "./bots";

// Shared CI runners are noisy; budgets are checked strictly on dev machines.
const SLACK = process.env.CI ? 3 : 1;

const lines = (f: string) =>
  readFileSync(new URL(`../../test/corpus/${f}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);

describe("bot detection", () => {
  const isBot = createBotDetector();

  it.each(lines("bots.txt"))("bot: %s", (ua) => expect(isBot(ua)).toBe(true));
  it.each(lines("humans.txt"))("human: %s", (ua) => expect(isBot(ua)).toBe(false));

  it("treats a missing or empty user agent as a bot", () => {
    expect(isBot(null)).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot("   ")).toBe(true);
  });

  it("supports extra patterns from config", () => {
    const custom = createBotDetector(["acme-uptime", "^internal-"]);
    expect(custom("Mozilla/5.0 acme-uptime/2")).toBe(true);
    expect(custom("internal-check")).toBe(true);
    expect(custom(lines("humans.txt")[0]!)).toBe(false);
  });

  it("runs in < 0.1 ms per call", () => {
    const uas = [...lines("bots.txt"), ...lines("humans.txt")];
    for (const ua of uas) isBot(ua);
    const n = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) isBot(uas[i % uas.length]!);
    expect((performance.now() - t0) / n).toBeLessThan(0.1 * SLACK);
  });
});
