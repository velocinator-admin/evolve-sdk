// D84: what the released next-evolve 0.8.0 does with a bundle that carries a
// constrained route key. Its matcher reads `:name(…)` as a segment that is
// neither a literal nor a `:param`, so it drops the whole key: the route never
// matches, every page serves control and nothing is counted. In particular it
// does NOT fall back to an unconstrained `/:name` that would catch /pricing.
// So the cloud may publish constrained keys to 0.8 sites as-is.
import { describe, expect, it } from "vitest";
import { bundleRoutes } from "./routes";

const PERSON = "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)";
const OLD = new URL("../../node_modules/next-evolve-0.8.0/dist/core/routes.js", import.meta.url);

type OldTable = { match(path: string): { key: string } | null };
const loadOld = async () =>
  (await import(OLD.href)) as {
    bundleRoutes(b: { routing: { routes: Record<string, string[]> } }): OldTable;
  };

const bundle = () => ({
  routing: { routes: { [PERSON]: ["k3j9x2"], "/lp/:slug": ["p7q8r9"], "/pricing": ["m1n2o3"] } },
});

describe("next-evolve 0.8.0 with a constrained route key (released package)", () => {
  it("never matches the constrained key: person pages and /pricing alike", async () => {
    const old = (await loadOld()).bundleRoutes(bundle());
    expect(old.match("/Christopher-G")).toBeNull();
    expect(old.match("/about")).toBeNull();
    expect(old.match("/pricing")?.key).toBe("/pricing");
    // Other patterns in the same bundle keep working.
    expect(old.match("/lp/a")?.key).toBe("/lp/:slug");
  });

  it("0.9 serves the constrained key only where it matches", () => {
    const t = bundleRoutes(bundle());
    expect(t.match("/Christopher-G")?.key).toBe(PERSON);
    expect(t.match("/about")).toBeNull();
    expect(t.match("/pricing")?.key).toBe("/pricing");
  });
});
