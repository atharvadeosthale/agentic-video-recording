import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Scenario } from "./scenario.js";

/** Import a .ts/.js scenario file and return its default (or `scenario`) export. */
export async function loadScenario(file: string): Promise<Scenario> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`Scenario file not found: ${abs}`);
  await checkSessionCalls(abs);
  let mod: any;
  if (/\.(ts|mts|cts|tsx)$/.test(abs)) {
    const { tsImport } = await import("tsx/esm/api");
    mod = await tsImport(pathToFileURL(abs).href, import.meta.url);
  } else {
    mod = await import(pathToFileURL(abs).href);
  }
  const sc = mod.default ?? mod.scenario;
  if (!sc || typeof sc.run !== "function") {
    // A .ts file outside an ESM package is loaded as CommonJS, which hides the default export.
    const cjs = mod && mod["module.exports"] ? ` The file was loaded as CommonJS: add a package.json containing {"type":"module"} next to it, or rename it to .mts.` : "";
    throw new Error(`${file} must export a scenario created with defineScenario().${cjs}`);
  }
  return sc as Scenario;
}

/**
 * Catch a misspelled session method before a browser launches. Without this, a typo such
 * as `s.waitForUrl` only fails when the run reaches it, which can be minutes in.
 */
async function checkSessionCalls(abs: string) {
  const { Session } = await import("./runner/session.js");
  const known = new Set<string>([...Object.getOwnPropertyNames(Session.prototype), "page", "config", "events"]);
  const lines = readFileSync(abs, "utf8").split("\n");
  const problems: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const m of line.matchAll(/(?<![\w.])s\.(\w+)\s*\(/g)) {
      if (known.has(m[1])) continue;
      const guess = [...known].find((k) => k.toLowerCase() === m[1].toLowerCase()) ?? [...known].find((k) => k.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 5)));
      problems.push(`  line ${i + 1}: s.${m[1]}() is not a session method${guess ? `. Did you mean s.${guess}()?` : ""}`);
    }
  });
  if (problems.length) throw new Error(`${abs} calls methods the session does not have:\n${problems.join("\n")}`);
}
