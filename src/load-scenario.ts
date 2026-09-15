import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Scenario } from "./scenario.js";

/** Import a .ts/.js scenario file and return its default (or `scenario`) export. */
export async function loadScenario(file: string): Promise<Scenario> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`Scenario file not found: ${abs}`);
  let mod: any;
  if (/\.(ts|mts|cts|tsx)$/.test(abs)) {
    const { tsImport } = await import("tsx/esm/api");
    mod = await tsImport(pathToFileURL(abs).href, import.meta.url);
  } else {
    mod = await import(pathToFileURL(abs).href);
  }
  const sc = mod.default ?? mod.scenario;
  if (!sc || typeof sc.run !== "function") throw new Error(`${file} must export a scenario created with defineScenario()`);
  return sc as Scenario;
}
