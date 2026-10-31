import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getOptimizableMeta, optimizable } from "./optimizable";

const heroSchema = z.object({
  title: z.string().min(3).max(60).meta({ label: "Headline" }),
  subtitle: z.string().max(140).optional(),
  cta: z.string().min(2).max(24).meta({ label: "Button text" }),
  layout: z.enum(["left", "center"]).default("left"),
});
function Hero(_props: z.infer<typeof heroSchema> & { href?: string }) {
  return null;
}
const changed = heroSchema.extend({ title: z.string().max(61) });
function Hero2(_p: z.infer<typeof changed>) {
  return null;
}

describe("optimizable", () => {
  it("attaches schema, JSON Schema with .meta(), hash and keys", () => {
    const H = optimizable(Hero, heroSchema);
    const m = getOptimizableMeta(H)!;
    expect(m.keys).toEqual(["title", "subtitle", "cta", "layout"]);
    expect(m.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    const props = m.jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.title).toMatchObject({
      type: "string",
      minLength: 3,
      maxLength: 60,
      label: "Headline",
    });
    expect(props.layout).toMatchObject({ enum: ["left", "center"], default: "left" });
    expect(H).not.toBe(Hero);
    expect((H as unknown as { inner: unknown }).inner).toBe(Hero);
  });

  it("hash is stable and changes with the schema", () => {
    const a = getOptimizableMeta(optimizable(Hero, heroSchema))!.schemaHash;
    const b = getOptimizableMeta(optimizable(Hero, heroSchema))!.schemaHash;
    expect(a).toBe(b);
    expect(getOptimizableMeta(optimizable(Hero2, changed))!.schemaHash).not.toBe(a);
  });

  it("returns null for plain components", () => {
    expect(getOptimizableMeta(() => null)).toBeNull();
  });
});

// ---- compile-time checks (pnpm typecheck) ----
function NumberTitle(_p: { title: number }) {
  return null;
}
function NoCta(_p: { title: string }) {
  return null;
}
const s = z.object({ title: z.string(), cta: z.string() });
// @ts-expect-error schema says title is a string; the component wants a number
optimizable(NumberTitle, z.object({ title: z.string() }));
// @ts-expect-error schema has `cta`, the component doesn't accept it
optimizable(NoCta, s);
optimizable(NoCta, z.object({ title: z.string() })); // ok
