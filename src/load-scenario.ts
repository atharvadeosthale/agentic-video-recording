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
  const lines = blankNonCode(readFileSync(abs, "utf8")).split("\n");
  const problems: string[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?<![\w.])s\.(\w+)\s*\(/g)) {
      if (known.has(m[1])) continue;
      const guess = [...known].find((k) => k.toLowerCase() === m[1].toLowerCase()) ?? [...known].find((k) => k.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 5)));
      problems.push(`  line ${i + 1}: s.${m[1]}() is not a session method${guess ? `. Did you mean s.${guess}()?` : ""}`);
    }
  });
  if (problems.length) throw new Error(`${abs} calls methods the session does not have:\n${problems.join("\n")}`);
}

/**
 * Replace the contents of comments, strings, and template literals with spaces, keeping
 * newlines so line numbers hold. Code inside `${}` stays, since it can call the session.
 * Page scripts written as strings often have their own `s` variable, and they must not
 * be read as session calls.
 */
export function blankNonCode(src: string): string {
  const out: string[] = [];
  // Each entry is the `{}` depth inside one open `${}`. Empty means plain code.
  const holes: number[] = [];
  let i = 0;
  const blank = (end: number) => {
    for (; i < end; i++) out.push(src[i] === "\n" ? "\n" : " ");
  };
  const quoted = (quote: string) => {
    let j = i + 1;
    while (j < src.length && src[j] !== quote && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    blank(Math.min(j + 1, src.length));
  };
  /** Blank template text from `i` up to the closing backtick or the next `${`. */
  const template = () => {
    let j = i;
    while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
    if (src[j] === "`") return blank(j + 1);
    blank(Math.min(j + 2, src.length));
    if (j < src.length) holes.push(0);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(end < 0 ? src.length : end);
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(end < 0 ? src.length : end + 2);
    } else if (c === '"' || c === "'") quoted(c);
    else if (c === "`") {
      blank(i + 1);
      template();
    } else if (c === "}" && holes.length && holes[holes.length - 1] === 0) {
      holes.pop();
      blank(i + 1);
      template();
    } else {
      if (holes.length && c === "{") holes[holes.length - 1]++;
      if (holes.length && c === "}") holes[holes.length - 1]--;
      out.push(c);
      i++;
    }
  }
  return out.join("");
}
