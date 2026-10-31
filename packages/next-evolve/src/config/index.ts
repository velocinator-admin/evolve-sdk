/** `next-evolve/config`: `defineConfig` and `defineGoals`. */
export {
  defineConfig,
  type EvolveConfig,
  type ResolvedConfig,
  type RouteConfig,
  resolveConfig,
} from "./config";
export {
  defineGoals,
  type EventGoal,
  type GoalDefinition,
  type GoalEvent,
  type Goals,
  type GoalWindow,
  type PageviewGoal,
  serializeGoals,
} from "./goals";
