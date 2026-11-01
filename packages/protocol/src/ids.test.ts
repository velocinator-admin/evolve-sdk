import { describe, expect, it } from "vitest";
import {
  ANON_ID_RE,
  GOAL_KEY_RE,
  ID_RE,
  isAnonId,
  isId,
  newAnonId,
  newId,
  newRequestId,
  newSecretKey,
  newSiteId,
  newWebhookSecret,
  parseSecretKey,
  REGION_ID_RE,
  REQUEST_ID_RE,
  SECRET_KEY_RE,
  SITE_ID_RE,
  WEBHOOK_SECRET_RE,
} from "./ids";

describe("ids", () => {
  it("generates ids matching their formats", () => {
    for (let i = 0; i < 1000; i++) {
      expect(newId()).toMatch(ID_RE);
      expect(newAnonId()).toMatch(ANON_ID_RE);
      expect(newSiteId()).toMatch(SITE_ID_RE);
      expect(newRequestId()).toMatch(REQUEST_ID_RE);
      expect(newWebhookSecret()).toMatch(WEBHOOK_SECRET_RE);
    }
  });

  it("generates 1e6 unique 6-char ids", () => {
    // 36^6 ≈ 2.2e9, so a few birthday collisions are expected among 1e6 draws;
    // ids are allocated by the cloud with a uniqueness check. What we check here
    // is that the generator is close to uniform (collision count near theory).
    const seen = new Set<string>();
    let dupes = 0;
    for (let i = 0; i < 1_000_000; i++) {
      const id = newId();
      if (seen.has(id)) dupes++;
      seen.add(id);
    }
    // Expected ≈ n²/2N ≈ 230; a biased generator would be far above.
    expect(dupes).toBeLessThan(400);
  }, 30_000); // 1e6 draws: ~5 s on CI runners

  it("generates 1e6 unique anon ids", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000_000; i++) seen.add(newAnonId());
    expect(seen.size).toBe(1_000_000);
  });

  it("validates ids strictly", () => {
    expect(isId("k3j9x2")).toBe(true);
    for (const bad of ["K3j9x2", "k3j9x", "k3j9x22", "k3j-x2", ""]) expect(isId(bad)).toBe(false);
    expect(isAnonId("a".repeat(22))).toBe(true);
    expect(isAnonId("a".repeat(21))).toBe(false);
    expect(isAnonId(`${"a".repeat(21)}=`)).toBe(false);
  });

  it("region ids and goal keys", () => {
    expect("hero").toMatch(REGION_ID_RE);
    expect("pricing-table-2").toMatch(REGION_ID_RE);
    expect("-hero").not.toMatch(REGION_ID_RE);
    expect("a".repeat(41)).not.toMatch(REGION_ID_RE);
    expect("signed_up").toMatch(GOAL_KEY_RE);
    expect("1signup").not.toMatch(GOAL_KEY_RE);
    expect("a".repeat(49)).not.toMatch(GOAL_KEY_RE);
  });

  it("secret keys embed the site id", () => {
    const site = newSiteId();
    const key = newSecretKey(site);
    expect(key).toMatch(SECRET_KEY_RE);
    expect(parseSecretKey(key)).toEqual({ siteId: site });
    expect(parseSecretKey("evk_live_site_short_x")).toBeNull();
    expect(parseSecretKey(`evk_test_${site}_${"a".repeat(32)}`)).toBeNull();
  });
});
