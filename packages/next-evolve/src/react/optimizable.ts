import { canonicalJson, REGION_ID_RE, sha256Hex } from "@next-evolve/protocol";
import { type ComponentType, createElement } from "react";
import { z } from "zod";

const META = Symbol.for("next-evolve.optimizable");

export type OptimizableMeta<S extends z.ZodObject = z.ZodObject> = {
  schema: S;
  /** JSON Schema of the editable props (dashboard forms; later the AI). Includes `.meta()`. */
  jsonSchema: Record<string, unknown>;
  /** sha256 of the canonical JSON Schema; changes when the schema changes. */
  schemaHash: string;
  keys: readonly string[];
};

export type OptimizableComponent<
  P extends object,
  S extends z.ZodObject = z.ZodObject,
> = ComponentType<P> & {
  readonly [META]: OptimizableMeta<S>;
};

/**
 * Compile-time check that the schema fits the component: every schema key is a
 * prop the component accepts, with a compatible type.
 */
type SchemaFits<P, O> = [Exclude<keyof O, keyof P>] extends [never]
  ? O extends Pick<P, keyof O & keyof P>
    ? unknown
    : { "schema error": "schema prop types don't match the component's props" }
  : {
      "schema error": "schema has props the component doesn't accept";
      keys: Exclude<keyof O, keyof P>;
    };

/**
 * Marks a component as optimizable with a Zod schema for the props Evolve may
 * change. A schema that doesn't fit the component's props fails to compile.
 * Server-only (the component renders inside `<Optimizable>`).
 *
 * ```ts
 * export default optimizable(Hero, heroSchema);
 * ```
 */
export function optimizable<P extends object, S extends z.ZodObject>(
  component: ComponentType<P>,
  schema: S & SchemaFits<P, z.output<S>>,
): OptimizableComponent<P, S> {
  const jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  const meta: OptimizableMeta<S> = {
    schema,
    jsonSchema,
    schemaHash: sha256Hex(canonicalJson(jsonSchema)),
    keys: Object.keys(schema.shape),
  };
  // A thin wrapper so the user's component is never mutated.
  const Wrapped = ((props: P) => createElement(component, props)) as OptimizableComponent<P, S>;
  Object.defineProperty(Wrapped, META, { value: meta });
  Object.defineProperty(Wrapped, "displayName", {
    value: `Optimizable(${component.displayName ?? component.name ?? "Component"})`,
  });
  Object.defineProperty(Wrapped, "inner", { value: component });
  return Wrapped;
}

export function getOptimizableMeta(c: unknown): OptimizableMeta | null {
  return (c as { [META]?: OptimizableMeta } | null)?.[META] ?? null;
}

export function isRegionId(id: string): boolean {
  return REGION_ID_RE.test(id);
}
