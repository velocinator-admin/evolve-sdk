import { PROTOCOL_VERSION, type RegionRegistration } from "@next-evolve/protocol";
import { pushToCloud } from "./push";

const sent = new Set<string>();
const MAX_SENT = 1000;

/**
 * Registers a region with the cloud (spec §5.2), once per process per
 * (id, schema, path). Errors are swallowed; a failed push is retried on a later render.
 */
export async function registerRegion(r: Omit<RegionRegistration, "pv">): Promise<void> {
  const key = `${r.id}|${r.schemaHash}|${r.path}`;
  if (sent.has(key)) return;
  sent.add(key);
  if (sent.size > MAX_SENT) sent.delete(sent.values().next().value!);
  const res = await pushToCloud("/v1/regions", { pv: PROTOCOL_VERSION, ...r });
  if (!res.ok && res.status !== "no_key") sent.delete(key);
}

/** Test helper. */
export function resetRegionRegistry(): void {
  sent.clear();
}
