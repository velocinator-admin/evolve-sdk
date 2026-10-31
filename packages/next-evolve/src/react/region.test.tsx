import type { BundlePayload } from "@next-evolve/protocol";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sampleBundle } from "../../test/samples";

const ctx = { code: null as string | null, path: null as string | null };
let bundles: (BundlePayload | null)[] = [];
const getRenderBundle = vi.fn(async (_o?: { fresh?: boolean }) =>
  bundles.length > 1 ? bundles.shift()! : bundles[0]!,
);
const headerCode = { value: null as string | null };

vi.mock("./context", () => ({ requestContext: () => ctx }));
vi.mock("./render-bundle", () => ({
  getRenderBundle: (o?: { fresh?: boolean }) => getRenderBundle(o),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(headerCode.value ? { "x-evolve-a": headerCode.value } : {}),
}));

const { Optimizable } = await import("./region");
const { optimizable } = await import("./optimizable");

const heroSchema = z.object({
  title: z.string().min(3).max(60),
  cta: z.string().max(24).optional(),
  layout: z.enum(["left", "center"]).default("left"),
});
function HeroImpl(p: z.infer<typeof heroSchema> & { href?: string }) {
  return p as unknown as ReactElement;
}
const Hero = optimizable(HeroImpl, heroSchema);
const control = { title: "Ship faster", cta: "Start free", href: "/signup" };
/** What the component receives for control: schema defaults applied. */
const controlOut = { ...control, layout: "left" };

type El = ReactElement<Record<string, unknown>>;
const render = (id = "hero") => Optimizable({ id, component: Hero, props: control }) as Promise<El>;
/** Unwraps the marker div (if any) and returns [markerProps | null, componentProps]. */
const inspect = (el: El): [Record<string, unknown> | null, Record<string, unknown>] =>
  el.type === "div" ? [el.props, (el.props.children as El).props] : [null, el.props];

beforeEach(() => {
  ctx.code = null;
  headerCode.value = null;
  bundles = [sampleBundle()];
  getRenderBundle.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("<Optimizable>", () => {
  it("ev_0 renders control with no marker and no bundle read", async () => {
    ctx.code = "ev_0";
    const [marker, props] = inspect(await render());
    expect(marker).toBeNull();
    expect(props).toEqual(controlOut);
    expect(getRenderBundle).not.toHaveBeenCalled();
  });

  it("renders a variant: props merged over control, with markers", async () => {
    ctx.code = "ev_k3j9x2-c1d2e3";
    const [marker, props] = inspect(await render());
    expect(marker).toMatchObject({
      style: { display: "contents" },
      "data-evolve-r": "hero",
      "data-evolve-e": "k3j9x2",
      "data-evolve-v": "c1d2e3",
    });
    expect(marker).not.toHaveProperty("data-evolve-x");
    expect(props).toEqual({ ...controlOut, title: "Ship 10x faster" });
  });

  it("control variant is marked and counted, with control props", async () => {
    ctx.code = "ev_k3j9x2-a8f2l1";
    const [marker, props] = inspect(await render());
    expect(marker).toMatchObject({ "data-evolve-v": "a8f2l1" });
    expect(props).toEqual(controlOut);
  });

  it("render-only pair (~) is marked x", async () => {
    ctx.code = "ev_k3j9x2~c1d2e3";
    const [marker, props] = inspect(await render());
    expect(marker).toHaveProperty("data-evolve-x", "");
    expect(props.title).toBe("Ship 10x faster");
  });

  it("a variant failing its schema renders control, marked x", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    bundles = [sampleBundle((b) => (b.variants.c1d2e3!.props = { title: "x".repeat(61) }))];
    ctx.code = "ev_k3j9x2-c1d2e3";
    const [marker, props] = inspect(await render());
    expect(marker).toHaveProperty("data-evolve-x", "");
    expect(props).toEqual(controlOut);
  });

  it("a missing variant refetches once; still missing → control, marked x", async () => {
    ctx.code = "ev_k3j9x2-zzzzzz";
    const [marker, props] = inspect(await render());
    expect(getRenderBundle).toHaveBeenCalledTimes(2);
    expect(getRenderBundle).toHaveBeenLastCalledWith({ fresh: true });
    expect(marker).toHaveProperty("data-evolve-x", "");
    expect(props).toEqual(controlOut);
  });

  it("a variant that appears after the refetch is rendered", async () => {
    const withNew = sampleBundle((b) => {
      b.routing.experiments.k3j9x2!.variants.push({ id: "n3wv4r", w: 0.1 });
      b.variants.n3wv4r = {
        exp: "k3j9x2",
        region: "hero",
        ctrl: false,
        props: { title: "Brand new" },
      };
    });
    bundles = [sampleBundle(), withNew];
    ctx.code = "ev_k3j9x2-n3wv4r";
    const [, props] = inspect(await render());
    expect(props.title).toBe("Brand new");
  });

  it("a region not in the code renders control without a marker", async () => {
    ctx.code = "ev_k3j9x2-c1d2e3";
    const [marker, props] = inspect(await render("footer"));
    expect(marker).toBeNull();
    expect(props).toEqual(controlOut);
  });

  it("dynamic mode reads the x-evolve-a header", async () => {
    headerCode.value = "ev_k3j9x2-c1d2e3";
    const [, props] = inspect(await render());
    expect(props.title).toBe("Ship 10x faster");
  });

  it("no context → control, one dev warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(inspect(await render())[0]).toBeNull();
    await render();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("malformed code → control", async () => {
    ctx.code = "ev_nope";
    expect(inspect(await render())).toEqual([null, controlOut]);
  });
});
