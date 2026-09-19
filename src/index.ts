export { defineScenario, withExplore, type Scenario, type ExplorePlan, type ExplorePage } from "./scenario.js";
export { exploreScenario, type ExploreOptions, type ExploreResult, type ExplorePageSpec } from "./runner/explore.js";
export { collectInventory, type InventoryElement, type InventoryPage, type InventoryBundle } from "./inventory.js";
export {
  indexFromPages,
  findEntry,
  pagesWithHandle,
  samePage,
  resolveRoleTarget,
  findAllRoleTargets,
  addressOf,
  targetOf,
  suggestedTarget,
  normalizeIndex,
  type AvrIndex,
  type RoleTarget,
  type IndexEntry,
  type Match,
  DEFAULT_INDEX_PATH,
} from "./resolver.js";
export { recordScenario, dryRunScenario, type RecordOptions, type RecordResult, type DryRunOptions, type DryRunResult } from "./runner/index.js";
export { Session, type Target, type ClickOptions, type MoveOptions, type TypeOptions, type ScrollOptions, type ZoomOptions } from "./runner/session.js";
export { renderRecording, type RenderOptions, type RenderResult } from "./compositor/render.js";
export { defaultConfig, resolveConfig } from "./config.js";
export * from "./types.js";
