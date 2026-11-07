import { CODE_RE, CONTROL_CODE } from "@next-evolve/protocol";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { type ComponentType, createElement, type ReactElement } from "react";
import { normalizePath } from "../config/config";
import { requestContext } from "./context";

/** Props Next passes to a page under `app/[evolve]/`. */
export type EvolvePageProps = {
  params: Promise<{ evolve: string } & Record<string, string | string[] | undefined>>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** Validates the `[evolve]` segment; malformed codes are a 404. */
async function readCode(params: EvolvePageProps["params"]): Promise<string> {
  const { evolve } = await params;
  if (typeof evolve !== "string" || !CODE_RE.test(evolve)) notFound();
  return evolve;
}

/**
 * Wraps a static-mode page under `app/[evolve]/<route>/page.tsx`. Decodes the
 * variant code from `params.evolve` and makes it available to every
 * `<Optimizable>` on the page before the body renders.
 */
export function withEvolve<P extends object>(
  Page: ComponentType<P>,
  opts: { path: string },
): (props: P & EvolvePageProps) => Promise<ReactElement> {
  const path = normalizePath(opts.path);
  async function EvolvePage(props: P & EvolvePageProps): Promise<ReactElement> {
    const code = await readCode(props.params);
    const ctx = requestContext();
    ctx.code = code;
    ctx.path = path;
    return createElement(Page, props);
  }
  Object.defineProperty(EvolvePage, "name", {
    value: `withEvolve(${Page.displayName ?? Page.name ?? "Page"})`,
  });
  return EvolvePage;
}

/** `generateStaticParams` for `app/[evolve]/`: prerenders control only, so builds need no network. */
export function evolveStaticParams(): { evolve: string }[] {
  return [{ evolve: CONTROL_CODE }];
}

/** `/lp/:slug` + `{ slug: "a" }` → `/lp/a`; catch-alls join their segments. */
function fillPattern(route: string, params: Record<string, string | string[] | undefined>): string {
  const out = route.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)([*+])?/g, (_m, name: string) => {
    const v = params[name];
    const segs = Array.isArray(v) ? v : v === undefined ? [] : [v];
    return segs.map((x) => `/${encodeURIComponent(x)}`).join("");
  });
  return out || "/";
}

type MetadataInput = Metadata | ((props: EvolvePageProps) => Metadata | Promise<Metadata>);

/**
 * `generateMetadata` for a static-mode page: canonical is the original path
 * for every variant, and variant renders are `noindex` (bots only ever get
 * control anyway).
 */
export function evolveMetadata(path: string, base: MetadataInput = {}) {
  const route = normalizePath(path);
  return async function generateMetadata(props: EvolvePageProps): Promise<Metadata> {
    const code = await readCode(props.params);
    // A pattern route (/lp/:slug) is canonical at the page's own path.
    const canonical = route.includes("/:") ? fillPattern(route, await props.params) : route;
    const m = typeof base === "function" ? await base(props) : base;
    return {
      ...m,
      alternates: { ...m.alternates, canonical },
      ...(code === CONTROL_CODE ? {} : { robots: { index: false, follow: true } }),
    };
  };
}
