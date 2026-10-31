import "server-only";

/** `next-evolve` (server components): regions, static-mode pages and metadata. */
export {
  getOptimizableMeta,
  type OptimizableComponent,
  type OptimizableMeta,
  optimizable,
} from "./react/optimizable";
export { Optimizable, type OptimizableProps } from "./react/region";
export {
  type EvolvePageProps,
  evolveMetadata,
  evolveStaticParams,
  withEvolve,
} from "./react/with-evolve";
