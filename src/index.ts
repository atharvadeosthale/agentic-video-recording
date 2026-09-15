export { defineScenario, type Scenario } from "./scenario.js";
export { recordScenario, dryRunScenario, type RecordOptions, type RecordResult, type DryRunOptions, type DryRunResult } from "./runner/index.js";
export { Session, type Target, type ClickOptions, type MoveOptions, type TypeOptions, type ScrollOptions, type ZoomOptions } from "./runner/session.js";
export { renderRecording, type RenderOptions, type RenderResult } from "./compositor/render.js";
export { defaultConfig, resolveConfig } from "./config.js";
export * from "./types.js";
