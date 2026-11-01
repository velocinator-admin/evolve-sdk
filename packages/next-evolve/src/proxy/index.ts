/** `next-evolve/proxy`: runs in `proxy.ts` (Node). Never imports the DB driver. */
export {
  applyEvolve,
  createEvolveProxy,
  type EvolveProxyOptions,
  evolveReady,
} from "./proxy";
