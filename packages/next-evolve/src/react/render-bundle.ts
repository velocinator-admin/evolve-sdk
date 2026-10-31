import type { BundlePayload } from "@next-evolve/protocol";
import { getBundleStore } from "../store/runtime";

/**
 * Bundle for rendering. Phase 1 (M1): the process-wide store shared with the
 * proxy; `fresh` awaits a refetch first. T7.6 adds the tagged fetch for hosts
 * where render and proxy run in different processes.
 */
export async function getRenderBundle(
  opts: { fresh?: boolean } = {},
): Promise<BundlePayload | null> {
  const store = getBundleStore({});
  if (!store) return null;
  if (opts.fresh) await store.refresh();
  return store.peek();
}
