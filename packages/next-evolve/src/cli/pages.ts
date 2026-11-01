// `init` step 7 (spec §16.1): static-mode pages move under app/[evolve]/.
// T11.3 moves them; until then the move is a manual step.
import type { Detection } from "./detect";
import type { RouteMode } from "./files";
import type { Plan } from "./plan";

export function planPages(plan: Plan, d: Detection, routes: RouteMode[]): RouteMode[] {
  for (const r of routes) {
    if (r.mode === "static") {
      plan.manual.push(
        `Move the page for ${r.path} under ${d.appDir}/[evolve]/ and wrap it with withEvolve()`,
      );
    }
  }
  return routes;
}
