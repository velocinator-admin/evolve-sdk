import { type BundlePayload, CONTROL_CODE, type CodePair, decodeCode } from "@next-evolve/protocol";
import { createElement, type ReactElement } from "react";
import type { z } from "zod";
import { HEADER_CODE } from "../core/constants";
import { logRateLimited } from "../core/log";
import { requestContext } from "./context";
import { getOptimizableMeta, type OptimizableComponent } from "./optimizable";
import { getRenderBundle } from "./render-bundle";

/** Control props: the schema's input type (defaults optional) plus the component's other props. */
export type ControlProps<P extends object, S extends z.ZodObject> = Omit<P, keyof z.output<S>> &
  z.input<S>;

export type OptimizableProps<P extends object, S extends z.ZodObject> = {
  /** Region id, unique per site: /^[a-z0-9][a-z0-9-]{0,39}$/. */
  id: string;
  component: OptimizableComponent<P, S>;
  /** Control props. Variant props are merged over these; schema defaults apply. */
  props: ControlProps<P, S>;
};

let warnedNoContext = false;

async function currentCode(): Promise<string | null> {
  const ctx = requestContext();
  if (ctx.code) return ctx.code;
  // Dynamic mode: the proxy passes the code as a request header.
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get(HEADER_CODE);
  } catch {
    return null;
  }
}

function findPair(bundle: BundlePayload | null, pairs: CodePair[], region: string) {
  for (const p of pairs) {
    const v = bundle?.variants[p.var];
    if (v && v.exp === p.exp && v.region === region) return { pair: p, variant: v };
  }
  return null;
}

/**
 * Renders the variant of a region chosen by the proxy, or control. Never throws
 * because of Evolve: any problem renders control. Server component.
 */
export async function Optimizable<P extends object, S extends z.ZodObject>({
  id,
  component,
  props,
}: OptimizableProps<P, S>): Promise<ReactElement> {
  const meta = getOptimizableMeta(component);
  if (!meta) {
    logRateLimited(
      `optimizable:${id}`,
      `<Optimizable id="${id}">: component isn't wrapped with optimizable()`,
    );
    return createElement(component, props as unknown as P);
  }
  const editableOf = (o: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of meta.keys) if (k in o) out[k] = o[k];
    return out;
  };
  // Control gets schema defaults too; if the developer's own props fail the schema, render them as-is.
  const parsedControl = meta.schema.safeParse(editableOf(props));
  const controlProps = {
    ...props,
    ...(parsedControl.success ? (parsedControl.data as object) : {}),
  } as unknown as P;
  const control = () => createElement(component, controlProps);

  const code = await currentCode();
  if (!code) {
    if (!warnedNoContext && process.env.NODE_ENV !== "production") {
      warnedNoContext = true;
      console.warn(
        `[evolve] <Optimizable id="${id}"> rendered without Evolve context; serving control. ` +
          "Wrap the page with withEvolve() under app/[evolve]/, or use a dynamic route.",
      );
    }
    return control();
  }
  if (code === CONTROL_CODE) return control();
  const pairs = decodeCode(code);
  if (!pairs || pairs.length === 0) return control();

  let bundle = await getRenderBundle();
  let hit = findPair(bundle, pairs, id);
  const unknown = () => pairs.some((p) => !bundle?.variants[p.var]);
  if (!hit && unknown()) {
    bundle = await getRenderBundle({ fresh: true });
    hit = findPair(bundle, pairs, id);
  }
  const marker = (attrs: Record<string, string>, child: ReactElement) =>
    createElement("div", { style: { display: "contents" }, "data-evolve-r": id, ...attrs }, child);

  if (!hit) {
    // The code names a variant we still can't resolve: render control, not counted.
    return unknown() ? marker({ "data-evolve-x": "" }, control()) : control();
  }
  const { pair, variant } = hit;
  const attrs: Record<string, string> = { "data-evolve-e": pair.exp, "data-evolve-v": pair.var };
  if (!pair.counted) attrs["data-evolve-x"] = "";

  if (variant.ctrl || Object.keys(variant.props).length === 0) return marker(attrs, control());

  const parsed = meta.schema.safeParse(editableOf({ ...props, ...variant.props }));
  if (!parsed.success) {
    logRateLimited(
      `variant:${pair.var}`,
      `variant ${pair.var} of region "${id}" failed its schema; serving control`,
      parsed.error.issues,
    );
    return marker({ ...attrs, "data-evolve-x": "" }, control());
  }
  return marker(
    attrs,
    createElement(component, { ...props, ...(parsed.data as object) } as unknown as P),
  );
}
