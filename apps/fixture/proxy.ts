import { createEvolveProxy } from "next-evolve/proxy";
import buildBundle from "./.evolve/bundle.generated";
import evolveConfig from "./evolve.config";

export const proxy = createEvolveProxy(evolveConfig, { buildBundle });

export const config = { matcher: ["/", "/pricing", "/features", "/slow", "/(ev_.*)"] };
