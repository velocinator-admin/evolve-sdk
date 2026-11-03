/** `next-evolve/config`: `defineConfig` and `defineGoals`. */
export {
  CDN_CODE_PATTERN,
  cdnCookieName,
  evolveMatcher,
  evolveRewrites,
  type MatcherEntry,
} from "./cdn";
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
