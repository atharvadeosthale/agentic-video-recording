import type { Page } from "playwright";
import type { UserScenarioConfig } from "./types.js";
import type { Session } from "./runner/session.js";

/** A page `avr explore` should inventory. */
export interface ExplorePage {
  /** Path (joined with `baseUrl`), an absolute URL, or `"auto"` for the current page. */
  path: string;
  /** Wait for this selector before inventorying, for late-rendered UI. */
  waitFor?: string;
  /** Extra settle time after load, ms. */
  settle?: number;
  /** Steps to reach a sub-view (open a dialog, switch a tab) before inventorying. */
  prepare?: (page: Page) => Promise<void>;
}

/**
 * An exploration plan, so `avr explore scenario.ts` can walk the pages a recording needs
 * and produce handles for them. Optional: scenarios without one are recorded normally.
 */
export interface ExplorePlan {
  /** Base URL prepended to relative page paths. */
  baseUrl?: string;
  pages: ExplorePage[];
  /** Run once before the walk: log in, enable a mode, dismiss a banner. */
  setup?: (page: Page) => Promise<void>;
}

export interface Scenario {
  config: UserScenarioConfig;
  run: (s: Session) => Promise<void>;
  /** Optional exploration plan consumed by `avr explore`. */
  explore?: ExplorePlan;
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

/** Attach an exploration plan to a scenario so `avr explore` knows what to walk. */
export function withExplore(scenario: Scenario, plan: ExplorePlan): Scenario {
  return { ...scenario, explore: plan };
}
