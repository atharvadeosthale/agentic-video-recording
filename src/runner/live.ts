/**
 * Live steps: the verbs behind `avr do`. A step is plain data, so the same record can be
 * executed in the session browser, kept in the journal, replayed to verify a path, and
 * written out as scenario code.
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import type { InventoryElement } from "../inventory.js";
import type { Observation } from "../observe.js";
import type { Session } from "./session.js";
import { distinguish } from "../resolver.js";

/** A target that survives JSON: what the journal stores and the exporter prints. */
export type PlainTarget =
  | string
  | { role: string; name: string; nth?: number; exact?: boolean; near?: string }
  | { text: string; nth?: number; exact?: boolean; near?: string }
  | { x: number; y: number };

export type Step =
  | { verb: "goto"; url: string }
  | { verb: "click" | "hover" | "scrollTo" | "zoom"; target: PlainTarget }
  | { verb: "type"; target: PlainTarget | null; text: string }
  | { verb: "press"; key: string }
  | { verb: "scroll"; dy: number }
  | { verb: "waitFor"; target: PlainTarget; gone?: boolean; timeout?: number }
  | { verb: "waitUrl"; pattern: string; timeout?: number }
  | { verb: "wait"; ms: number }
  | { verb: "zoomOut" }
  | { verb: "mark"; name: string };

/** Steps that only move the camera or the clock. They never change page state. */
export const isCameraStep = (s: Step) => s.verb === "zoom" || s.verb === "zoomOut" || s.verb === "wait" || s.verb === "mark" || s.verb === "hover";

export interface JournalEntry {
  id: number;
  step: Step;
  /** The scenario line this step exports as. */
  code: string;
  urlBefore: string;
  urlAfter: string;
  stateBefore: string;
  stateAfter: string;
  /** Set when the steps from `detourFrom` to here returned the page to an earlier state. */
  detour?: boolean;
  /** Explicit agent decision, overriding detour detection. */
  keep?: boolean;
  drop?: boolean;
  /** Explicit agent decision: run this before the recording starts, unrecorded. */
  setup?: boolean;
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Intent -> element
// ---------------------------------------------------------------------------

const CLICKY = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch", "combobox", "treeitem", "row"]);
const TYPEY = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const ROLES = new Set([...CLICKY, ...TYPEY, "heading", "img", "dialog", "navigation", "status", "alert", "cell", "listitem", "slider", "region", "banner", "main", "form", "list", "table", "tablist", "menu", "application"]);

export interface Pick {
  el: InventoryElement;
  score: number;
  /** Other elements that matched about as well, in visual order. */
  alternatives: InventoryElement[];
}

/**
 * Choose the element an agent means by a phrase like "new project". Exact names beat
 * prefixes beat substrings, and roles that suit the verb win ties, so "PostgreSQL" picks
 * the card button rather than a label that happens to contain the word.
 */
export function pickElement(obs: Observation, query: string, verb: Step["verb"], opts: { role?: string; nth?: number } = {}): Pick | null {
  const q = norm(query);
  const qTokens = q.split(" ").filter(Boolean);
  const scored = obs.elements
    .filter((e) => !opts.role || e.role === opts.role)
    .map((el) => {
      const n = norm(el.name);
      let score = 0;
      if (!n) score = 0;
      else if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80;
      else if (new RegExp(`\\b${escapeRe(q)}\\b`).test(n)) score = 66;
      else if (n.includes(q)) score = 56;
      else if (qTokens.length > 1 && qTokens.every((t) => n.includes(t))) score = 46;
      else {
        const hit = qTokens.filter((t) => t.length > 2 && n.includes(t)).length;
        score = qTokens.length ? (hit / qTokens.length) * 30 : 0;
      }
      if (score > 0) {
        if (verb === "type") score += TYPEY.has(el.role) ? 30 : -40;
        else if (verb === "click") score += CLICKY.has(el.role) ? 10 : el.role === "heading" ? -20 : 0;
        if (el.disabled) score -= 15;
        // Among equally good matches, the tighter name is the more specific element.
        score -= Math.min(8, Math.max(0, n.length - q.length) / 12);
      }
      return { el, score };
    })
    .filter((s) => s.score >= 20)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const close = scored.filter((s) => scored[0].score - s.score < 6).map((s) => s.el);
  const chosen = opts.nth ? close[opts.nth - 1] : close[0];
  if (!chosen) return null;
  return { el: chosen, score: scored[0].score, alternatives: close.filter((e) => e !== chosen) };
}

/** The elements nearest to a phrase, for a miss. */
export function nearest(obs: Observation, query: string, limit = 6): InventoryElement[] {
  const qTokens = norm(query).split(" ").filter((t) => t.length > 1);
  return obs.elements
    .map((el) => ({ el, s: qTokens.filter((t) => norm(`${el.role} ${el.name}`).includes(t)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.el);
}

/**
 * Turn a picked element into an address that a scenario can replay: role+name when
 * Playwright agrees it points at this exact element, then text, then a stable attribute,
 * and the point as a last resort. `nth` is set by matching boxes, not by guessing order.
 */
export async function addressFor(page: Page, el: InventoryElement): Promise<PlainTarget> {
  const sameBox = (b: { x: number; y: number } | null) => !!b && Math.abs(b.x - el.x) <= 3 && Math.abs(b.y - el.y) <= 3;
  const nthOf = async (loc: import("playwright").Locator): Promise<{ count: number; nth: number; near?: string } | null> => {
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 25); i++) {
      if (!sameBox(await loc.nth(i).boundingBox().catch(() => null))) continue;
      // A tie is better broken by what sits next to the element than by its position.
      const near = count > 1 ? (await distinguish(loc))[i] : undefined;
      return { count, nth: i + 1, near };
    }
    return null;
  };
  const tie = (hit: { count: number; nth: number; near?: string }) => (hit.count <= 1 ? {} : hit.near ? { near: hit.near } : { nth: hit.nth });

  if (el.name && el.name.length <= 60) {
    const hit = await nthOf(page.getByRole(el.role as any, { name: el.name, exact: true }));
    if (hit) return { role: el.role, name: el.name, ...tie(hit) };
  }
  if (el.name) {
    // Long names are usually a card's whole text. A leading slice is a steadier address.
    const head = el.name.slice(0, 40).trim();
    const hit = await nthOf(page.getByRole(el.role as any, { name: head, exact: false }));
    if (hit) return { role: el.role, name: head, exact: false, ...tie(hit) };
    const byText = await nthOf(page.getByText(el.name, { exact: true }));
    if (byText) return { text: el.name, ...tie(byText) };
  }
  if (el.stable) {
    const css = el.stable.kind === "id" ? `#${el.stable.value.replace(/([^\w-])/g, "\\$1")}` : `[${el.stable.kind}="${el.stable.value.replace(/"/g, '\\"')}"]`;
    const hit = await nthOf(page.locator(css));
    if (hit && hit.count === 1) return css;
  }
  return { x: Math.round(el.x + el.width / 2), y: Math.round(el.y + el.height / 2) };
}

/** What sits on top of an element's centre, when it is not the element itself. */
export async function coveredBy(page: Page, el: InventoryElement): Promise<string | null> {
  return page
    .evaluate(
      ({ x, y, ex, ey, ew, eh }) => {
        const top = document.elementFromPoint(x, y);
        if (!top) return null;
        const r = top.getBoundingClientRect();
        // The element itself, something inside it, or a wrapper of about the same box.
        const inside = r.left >= ex - 2 && r.top >= ey - 2 && r.right <= ex + ew + 2 && r.bottom <= ey + eh + 2;
        if (inside) return null;
        let p: Element | null = top;
        while (p) {
          const pr = p.getBoundingClientRect();
          if (Math.abs(pr.left - ex) <= 3 && Math.abs(pr.top - ey) <= 3) return null;
          p = p.parentElement;
        }
        const label = top.getAttribute("aria-label") || (top as HTMLElement).innerText?.trim().slice(0, 40) || "";
        return `<${top.tagName.toLowerCase()}${top.getAttribute("role") ? ` role=${top.getAttribute("role")}` : ""}> ${JSON.stringify(label)}`;
      },
      { x: el.x + el.width / 2, y: el.y + el.height / 2, ex: el.x, ey: el.y, ew: el.width, eh: el.height },
    )
    .catch(() => null);
}

/**
 * Explicit address forms, for when the agent already knows what it wants:
 * `button:New project`, `text=Deployed`, `css=#db-name`, `120,340`.
 */
export function parseExplicit(query: string): { target?: PlainTarget; role?: string; phrase: string } {
  const css = /^css=(.+)$/s.exec(query);
  if (css) return { target: css[1], phrase: query };
  const text = /^text=(.+)$/s.exec(query);
  if (text) return { target: { text: text[1], exact: false }, phrase: query };
  const pt = /^(\d+)\s*,\s*(\d+)$/.exec(query);
  if (pt) return { target: { x: Number(pt[1]), y: Number(pt[2]) }, phrase: query };
  const roled = /^([a-z]+):(.+)$/s.exec(query);
  if (roled && ROLES.has(roled[1])) return { role: roled[1], phrase: roled[2].trim() };
  return { phrase: query };
}

// ---------------------------------------------------------------------------
// Execute and print
// ---------------------------------------------------------------------------

export async function runStep(s: Session, step: Step): Promise<void> {
  switch (step.verb) {
    case "goto":
      await s.goto(step.url, { waitUntil: "domcontentloaded" });
      return;
    case "click":
      return s.click(step.target);
    case "hover":
      return s.move(step.target);
    case "scrollTo":
      return s.scrollTo(step.target);
    case "zoom":
      return s.zoom(step.target);
    case "zoomOut":
      return s.zoomOut();
    case "type":
      return s.type(step.target, step.text);
    case "press":
      return s.press(step.key);
    case "scroll":
      return s.scroll({ dy: step.dy });
    case "waitFor":
      return s.waitFor(step.target, { state: step.gone ? "hidden" : "visible", timeout: step.timeout });
    case "waitUrl":
      return s.waitForURL(new RegExp(step.pattern), { timeout: step.timeout });
    case "wait":
      return s.wait(step.ms);
    case "mark":
      return s.mark(step.name);
  }
}

const lit = (t: PlainTarget | null) => (t === null ? "null" : JSON.stringify(t).replace(/"(\w+)":/g, "$1: ").replace(/,(\w)/g, ", $1").replace(/^\{/, "{ ").replace(/\}$/, " }"));

export function stepToCode(step: Step): string {
  switch (step.verb) {
    case "goto":
      return `await s.goto(${JSON.stringify(step.url)});`;
    case "click":
      return `await s.click(${lit(step.target)});`;
    case "hover":
      return `await s.move(${lit(step.target)});`;
    case "scrollTo":
      return `await s.scrollTo(${lit(step.target)});`;
    case "zoom":
      return `await s.zoom(${lit(step.target)});`;
    case "zoomOut":
      return `await s.zoomOut();`;
    case "type":
      return `await s.type(${lit(step.target)}, ${JSON.stringify(step.text)});`;
    case "press":
      return `await s.press(${JSON.stringify(step.key)});`;
    case "scroll":
      return `await s.scroll({ dy: ${step.dy} });`;
    case "waitFor":
      return `await s.waitFor(${lit(step.target)}${step.gone || step.timeout ? `, { ${[step.gone ? 'state: "hidden"' : "", step.timeout ? `timeout: ${step.timeout}` : ""].filter(Boolean).join(", ")} }` : ""});`;
    case "waitUrl":
      return `await s.waitForURL(/${step.pattern.replace(/\//g, "\\/")}/${step.timeout ? `, { timeout: ${step.timeout} }` : ""});`;
    case "wait":
      return `await s.wait(${step.ms});`;
    case "mark":
      return `// --- ${step.name} ---`;
  }
}

// ---------------------------------------------------------------------------
// Journal: which steps are the recording, and which were only looking around
// ---------------------------------------------------------------------------

/**
 * Mark detours. When the state after step i equals the state after an earlier step j,
 * everything in between went somewhere and came back (opened a menu and closed it,
 * visited a page and returned), so it is not part of the path. The agent never has to
 * declare a click exploratory up front; it can still override with keep/drop.
 */
export function markDetours(journal: JournalEntry[]): void {
  for (const e of journal) e.detour = false;
  // Walk forward keeping the "live path": a stack of entries whose states are all distinct.
  const path: JournalEntry[] = [];
  for (const e of journal) {
    if (!e.ok) {
      e.detour = true;
      continue;
    }
    // A phase boundary is a fresh path: setup may open something that the recording closes
    // again, and that is the point of the video, not a detour.
    if (e.step.verb === "mark" && /^(setup|start)$/i.test(e.step.name)) path.length = 0;
    // Typing, key presses and waits often change nothing the fingerprint can see (a canvas
    // terminal, a code editor). Only a click that changes nothing is a likely mistake.
    const unchanged = e.stateAfter === e.stateBefore && e.step.verb !== "click";
    if (isCameraStep(e.step) || unchanged) {
      path.push(e);
      continue;
    }
    // Back where an earlier step left us (or where the journal began): unwind to there.
    let back = -2;
    for (let i = path.length - 1; i >= 0; i--) {
      if (!isCameraStep(path[i].step) && path[i].stateAfter !== path[i].stateBefore && path[i].stateAfter === e.stateAfter) {
        back = i;
        break;
      }
    }
    if (back === -2 && path.length && firstState(path) === e.stateAfter) back = -1;
    if (back !== -2) {
      for (const d of path.splice(back + 1)) d.detour = true;
      e.detour = true;
    } else {
      path.push(e);
    }
  }
}

const firstState = (path: JournalEntry[]) => path.find((p) => !isCameraStep(p.step))?.stateBefore;

export type Phase = "explore" | "setup" | "record";

/**
 * Which part of the scenario each journal entry belongs to. `avr mark setup` opens the
 * unrecorded setup (put the app in the state the video starts from), `avr mark start`
 * begins the recording, and everything before either was looking around. With no marks at
 * all, every step is part of the recording.
 */
export function phases(journal: JournalEntry[]): Phase[] {
  const out: Phase[] = [];
  let phase: Phase = "record";
  journal.forEach((e, i) => {
    if (e.step.verb === "mark" && /^setup$/i.test(e.step.name)) {
      out.fill("explore", 0, i);
      phase = "setup";
    } else if (e.step.verb === "mark" && /^start$/i.test(e.step.name)) {
      if (phase !== "setup") out.fill("explore", 0, i);
      phase = "record";
    }
    out.push(phase);
  });
  return out;
}

/** Entries that make it into the export, split into unrecorded setup and the recording. */
export function keptEntries(journal: JournalEntry[]): { setup: JournalEntry[]; record: JournalEntry[] } {
  const phase = phases(journal);
  const setup: JournalEntry[] = [];
  const record: JournalEntry[] = [];
  journal.forEach((e, i) => {
    const marker = e.step.verb === "mark" && /^(setup|start)$/i.test(e.step.name);
    if (marker || e.drop || (!e.keep && !e.setup && e.detour)) return;
    // Asking to keep (or set up) a step from before the marks can only mean: run it first.
    if (e.setup || phase[i] === "setup" || (phase[i] === "explore" && e.keep)) setup.push(e);
    else if (phase[i] === "record") record.push(e);
  });
  return { setup, record };
}

export function formatJournal(journal: JournalEntry[]): string[] {
  const kept = keptEntries(journal);
  const setup = new Set(kept.setup.map((e) => e.id));
  const record = new Set(kept.record.map((e) => e.id));
  const phase = phases(journal);
  return journal.map((e, i) => {
    const why = setup.has(e.id) ? "setup" : record.has(e.id) ? "record" : e.drop ? "drop" : !e.ok ? "failed" : e.detour ? "detour" : phase[i] === "explore" ? "explore" : "mark";
    return `#${String(e.id).padEnd(3)} ${why.padEnd(8)} ${e.code}`;
  });
}

export const STEPS_BEGIN = "// avr:steps-begin";
export const STEPS_END = "// avr:steps-end";
export const SETUP_BEGIN = "// avr:setup-begin";
export const SETUP_END = "// avr:setup-end";

export type BlockKind = "steps" | "setup";
const markers = (kind: BlockKind) => (kind === "setup" ? [SETUP_BEGIN, SETUP_END] : [STEPS_BEGIN, STEPS_END]);

const blockHash = (lines: string) => createHash("sha1").update(lines.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 10);

/**
 * Journal entries as scenario lines, wrapped in markers so a later export can replace just
 * them. Recorded steps get beats between them so the video can be read; setup steps run
 * back to back because nobody watches them.
 */
export function stepsBlock(startUrl: string, entries: JournalEntry[], kind: BlockKind = "steps", indent = "    "): string {
  const body: string[] = [];
  let prevUrl = startUrl;
  for (const e of entries) {
    body.push(e.code);
    if (e.step.verb === "mark") continue;
    // A navigation needs the new page to be usable; anything else needs a beat to read.
    if (e.urlAfter.split(/[?#]/)[0] !== prevUrl.split(/[?#]/)[0] || e.step.verb === "goto") body.push("await s.ready();");
    prevUrl = e.urlAfter;
    if (kind === "setup") continue;
    // A zoom needs time on screen before anything else happens; other steps need a beat.
    if (e.step.verb === "zoom") body.push("await s.wait(1400);");
    else if (e.step.verb !== "wait" && e !== entries.at(-1)) body.push(`await s.wait(${e.step.verb === "type" ? 600 : 800});`);
  }
  const [begin, end] = markers(kind);
  const inner = body.map((l) => indent + l).join("\n");
  return `${indent}${begin} ${blockHash(inner)} (replaced by \`avr session export\`; edits outside this block are kept)\n${inner}\n${indent}${end}`;
}

/**
 * Put a fresh block into an existing scenario file. Everything outside the markers
 * (config, imports, helpers, login) is the author's and is left alone. Refuses when the
 * file has no such block, or when the block was edited by hand since it was written.
 */
export function replaceStepsBlock(source: string, block: string, kind: BlockKind = "steps"): { source?: string; refused?: string } {
  const [begin, end] = markers(kind);
  const lines = source.split("\n");
  const b = lines.findIndex((l) => l.includes(begin));
  const e = lines.findIndex((l, i) => i > b && l.includes(end));
  if (b < 0 || e < 0)
    return {
      refused:
        kind === "setup"
          ? `the journal has setup steps, but the file has no setup block. Put two lines before startRecording() in the scenario body, "${begin}" and "${end}", and export again`
          : `it has contents but no steps block. To add the steps to this file, put two lines where they belong in the scenario body, "${begin}" and "${end}", and export again`,
    };
  const recorded = new RegExp(`${begin.slice(3)} (\\w+)`).exec(lines[b])?.[1];
  const current = lines.slice(b + 1, e).join("\n");
  // Empty markers are a placeholder the author put there: fill them.
  const placeholder = !recorded && !current.trim();
  if (!placeholder && recorded !== blockHash(current)) return { refused: `the ${kind} block was edited by hand since the last export` };
  const indent = /^\s*/.exec(lines[b])![0];
  const fresh = block.split("\n").map((l) => indent + l.trimStart());
  return { source: [...lines.slice(0, b), ...fresh, ...lines.slice(e + 1)].join("\n") };
}

/** A new scenario file around a steps block. */
export function exportScenario(opts: { name: string; startUrl: string; block: string; setupBlock?: string; importFrom?: string; hasSetup?: boolean; pkg: string; viewport?: { width: number; height: number; deviceScaleFactor: number } }): string {
  const cfg = opts.importFrom ? `{ ...base.config, name: ${JSON.stringify(opts.name)} }` : `{ name: ${JSON.stringify(opts.name)}${opts.viewport ? `, viewport: ${JSON.stringify(opts.viewport)}` : ""} }`;
  const scenario = `defineScenario(${cfg}, async (s) => {
${opts.hasSetup ? "    // Log in the same way the session did. Not recorded.\n    await s.run(base.explore!.setup!, \"setup\");\n" : ""}    await s.goto(${JSON.stringify(opts.startUrl)});
    await s.ready();
${opts.setupBlock ? `\n    // Not recorded: puts the app in the state the video starts from.\n${opts.setupBlock}\n` : ""}
    await s.startRecording();
    await s.wait(800);
${opts.block}
    await s.wait(1200);
    await s.stopRecording();
  })`;
  return `// Written by \`avr session export\`. Edit the config freely: a later export only replaces the steps block.
import { defineScenario${opts.importFrom ? ", withExplore" : ""} } from ${JSON.stringify(opts.pkg)};
${opts.importFrom ? `import base from ${JSON.stringify(opts.importFrom)};\n` : ""}
export default ${opts.importFrom ? `withExplore(\n  ${scenario},\n  base.explore ?? { pages: [] },\n)` : scenario};
`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
