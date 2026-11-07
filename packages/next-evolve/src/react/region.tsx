import {
  type BundlePayload,
  CONTROL_CODE,
  type CodePair,
  decodeCode,
  fillPlaceholders,
  hasPlaceholders,
  MAX_REGION_VARS,
  VAR_NAME_RE,
} from "@next-evolve/protocol";
import { routeParamNames } from "@next-evolve/protocol/routes";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { after, connection } from "next/server";
import { createElement, type ReactElement } from "react";
import type { z } from "zod";
import { registerRegion } from "../cloud/regions";
import { HEADER_CODE, HEADER_PATH, HEADER_VARS } from "../core/constants";
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
  /**
   * Per-page values for `{var}` placeholders in variant copy (TPL-1.2), e.g.
   * CMS data: `vars={{ fullName: person.fullName }}`. Route params (`{name}`
   * for `/:name`) are available without this. The names are registered with
   * the cloud, never the values. A variant that uses a var this page doesn't
   * have renders control, uncounted.
   */
  vars?: Readonly<Record<string, string | number | null | undefined>>;
};

let warnedNoContext = false;

async function currentCode(): Promise<string | null> {
  const ctx = requestContext();
  if (ctx.code) return ctx.code;
  // Dynamic mode: the proxy passes the code as a request header. Reading
  // headers() also tells Next the route is dynamic, so its internal errors
  // (e.g. during prerender) must propagate.
  try {
    return (await headers()).get(HEADER_CODE);
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}

/** The page path this region renders on (static: withEvolve; dynamic: the proxy header). */
async function currentPath(): Promise<string | null> {
  const ctx = requestContext();
  if (ctx.path) return ctx.path;
  try {
    return (await headers()).get(HEADER_PATH);
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}

/** Route params for this render (static: withEvolve; dynamic: the proxy header). */
async function routeVars(): Promise<Record<string, string>> {
  const ctx = requestContext();
  if (ctx.vars) return ctx.vars;
  try {
    const raw = (await headers()).get(HEADER_VARS);
    if (!raw) return {};
    const v = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch (e) {
    unstable_rethrow(e);
    return {};
  }
}

/** Var names a region offers on `path`: the route's params plus the `vars` prop's keys. */
export function regionVarNames(path: string | null, vars: Record<string, unknown> | undefined) {
  const names = new Set(path ? routeParamNames(path) : []);
  for (const k of Object.keys(vars ?? {})) if (VAR_NAME_RE.test(k)) names.add(k);
  return [...names].sort().slice(0, MAX_REGION_VARS);
}

/**
 * Region registration (spec §5.2): after the response, deduped per process,
 * errors swallowed. `after()` is called from a timer, not during render: with
 * `cacheComponents` on, Next flags the clock read inside `after()` as
 * non-deterministic prerender I/O (a dev error overlay). Outside a request
 * scope (tests, some build steps) the push runs directly, still in the
 * background.
 */
export function scheduleRegistration(
  id: string,
  meta: { jsonSchema: Record<string, unknown>; schemaHash: string },
  controlProps: Record<string, unknown>,
  path: string | null,
  vars: string[] = [],
): void {
  if (!path) return;
  const run = () =>
    registerRegion({
      id,
      jsonSchema: meta.jsonSchema,
      schemaHash: meta.schemaHash,
      controlProps,
      path,
      // Protocol 1.4.0: names only. Omitted when empty (same message as before).
      ...(vars.length ? { vars } : {}),
    });
  setTimeout(() => {
    try {
      after(run);
    } catch {
      void run().catch(() => {});
    }
  }, 0);
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
  vars,
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
  const path = await currentPath();
  scheduleRegistration(
    id,
    meta,
    parsedControl.success ? (parsedControl.data as Record<string, unknown>) : editableOf(props),
    path,
    regionVarNames(path, vars),
  );
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
  // Dynamic mode (the code came from the proxy's header): the bundle read
  // below checks the clock. With cacheComponents, Next only allows that at
  // request time, so say so. The route is dynamic already; static mode
  // (withEvolve context) stays cacheable.
  if (!requestContext().code) await connection();

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

  // `{var}` placeholders (TPL-1.2): route params, then the `vars` prop. A var
  // this page doesn't have renders control, not counted.
  let variantProps = variant.props;
  if (hasPlaceholders(variantProps)) {
    const values: Record<string, string> = { ...(await routeVars()) };
    for (const [k, v] of Object.entries(vars ?? {})) {
      if (typeof v === "string") values[k] = v;
      else if (typeof v === "number" && Number.isFinite(v)) values[k] = String(v);
      else delete values[k];
    }
    const filled = fillPlaceholders(variantProps, values);
    if (!filled.ok) {
      logRateLimited(
        `var:${pair.var}:${filled.missing}`,
        `variant ${pair.var} of region "${id}" uses {${filled.missing}}, which this page doesn't provide; serving control`,
      );
      return marker({ ...attrs, "data-evolve-x": "" }, control());
    }
    variantProps = filled.value;
  }

  const parsed = meta.schema.safeParse(editableOf({ ...props, ...variantProps }));
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
