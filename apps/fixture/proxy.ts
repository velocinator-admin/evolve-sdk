import { createEvolveProxy } from "next-evolve/proxy";
import evolveConfig from "./evolve.config";

export const proxy = createEvolveProxy(evolveConfig);

export const config = { matcher: ["/", "/pricing", "/features", "/(ev_.*)"] };
