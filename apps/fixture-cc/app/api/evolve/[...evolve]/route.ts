import { createEvolveHandler } from "next-evolve/server";
import evolveConfig from "@/evolve.config";

export const { GET, POST } = createEvolveHandler({ config: evolveConfig });
