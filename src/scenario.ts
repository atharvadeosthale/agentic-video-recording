import type { UserScenarioConfig } from "./types.js";
import type { Session } from "./runner/session.js";

export interface Scenario {
  config: UserScenarioConfig;
  run: (s: Session) => Promise<void>;
}

/**
 * Define a recording scenario.
 *
 * ```ts
 * export default defineScenario({ name: "signup" }, async (s) => {
 *   await s.goto("http://localhost:3000");
 *   await s.startRecording();
 *   await s.click("text=Get started");
 * });
 * ```
 */
export function defineScenario(config: UserScenarioConfig, run: (s: Session) => Promise<void>): Scenario;
export function defineScenario(run: (s: Session) => Promise<void>): Scenario;
export function defineScenario(a: UserScenarioConfig | ((s: Session) => Promise<void>), b?: (s: Session) => Promise<void>): Scenario {
  if (typeof a === "function") return { config: {}, run: a };
  if (!b) throw new Error("defineScenario(config, run) requires a run function");
  return { config: a, run: b };
}
