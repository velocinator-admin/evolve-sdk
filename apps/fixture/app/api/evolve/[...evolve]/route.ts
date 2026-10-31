import { createEvolveHandler } from "next-evolve/server";
import evolveConfig from "@/evolve.config";
import goals from "@/evolve.goals";

export const { GET, POST } = createEvolveHandler({ config: evolveConfig, goals });
export const maxDuration = 60;
