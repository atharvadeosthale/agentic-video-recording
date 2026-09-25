/**
 * Turns an agent-friendly address (a `@eNN` handle or a role+name pair) into a live
 * Playwright locator, and explains near-misses when it cannot.
 */
import type { Locator, Page } from "playwright";
import type { InventoryElement, InventoryPage } from "./inventory.js";

/**
 * Address an element by what it *is* rather than where it lives. This survives DOM
 * churn that breaks CSS selectors.
 */
export interface RoleTarget {
  /** ARIA role, e.g. "button", "link", "textbox", "heading". */
  role: string;
  /** Accessible name. A string is matched exactly by default; a RegExp matches a group. */
  name: string | RegExp;
  /** 1-based index when several elements share the role and name. */
  nth?: number;
  exact?: boolean;
  /** Optional container to scope the search when role+name is ambiguous. */
  within?: string | Locator;
  /**
   * Text that sits next to the element you mean, e.g. a record id inside the same card.
   * Breaks a tie by content rather than by position, so it keeps working when the order
   * of the matches changes.
   */
  near?: string;
}

/**
 * Address an element by its visible text, for roles that do not take their name from
 * content (status, alert regions) or when no name is available.
 */
/** Any address a scenario can pass to the session. */
export type Target =
  | string
  | { role: string; name: string | RegExp; nth?: number; exact?: boolean; within?: string | Locator; near?: string }
  | { text: string | RegExp; nth?: number; exact?: boolean; within?: string | Locator; near?: string };

export interface TextTarget {
  text: string | RegExp;
  /** 1-based index when several elements share the text. */
  nth?: number;
  exact?: boolean;
  within?: string | Locator;
  /** Text next to the element you mean. See {@link RoleTarget.near}. */
  near?: string;
}

/** One member of a matched group. */
export interface Match {
  /** 1-based index to pass back as `nth`. */
  nth: number;
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IndexEntry {
  handle: string;
  url: string;
  role: string;
  name: string;
  nameFrom: string;
  nth: number;
  /**
   * The address to pass to the session for this element: role+name when the role derives
   * its name from content, a text target when it does not, and the handle itself when the
   * element is empty (a status region before it fills in).
   */
  target: Target;
  stable?: { kind: string; value: string };
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AvrIndex {
  version: 1;
  createdAt: string;
  pages: { url: string; title: string; elements: IndexEntry[] }[];
}

/** Stable file the CLI writes and the runner reads, so handles work across commands. */
export const DEFAULT_INDEX_PATH = ".takeone/inventory.json";

export function indexFromPages(pages: InventoryPage[]): AvrIndex {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    pages: pages.map((p) => {
      const seen = new Map<string, number>();
      return {
        url: p.url,
        title: p.title,
        elements: p.elements.map((el: InventoryElement) => {
          const key = `${el.role}::${el.name.toLowerCase()}`;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          return {
            handle: el.handle,
            url: p.url,
            role: el.role,
            name: el.name,
            nameFrom: el.nameFrom,
            nth: n,
            target: suggestedTarget({ ...el, handle: el.handle }, n),
            stable: el.stable,
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
          };
        }),
      };
    }),
  };
}

/**
 * Look up a handle. Handles are numbered per page (`@e1` on every page), so a handle is
 * only meaningful together with a URL. Callers that know the current URL must pass it,
 * or they will resolve a same-numbered element from a different page.
 */
export function findEntry(index: AvrIndex, handle: string, currentUrl?: string): IndexEntry | undefined {
  if (currentUrl) {
    const here = index.pages.find((p) => samePage(p.url, currentUrl));
    const hit = here?.elements.find((e) => e.handle === handle);
    if (hit) return hit;
  }
  const hits = index.pages
    .map((p) => p.elements.find((e) => e.handle === handle))
    .filter((e): e is IndexEntry => Boolean(e));
  // Only fall back to an unambiguous cross-page match.
  return hits.length === 1 ? hits[0] : undefined;
}

/** True when two URLs point at the same page, ignoring query strings and hash. */
export function samePage(a: string, b: string): boolean {
  const strip = (u: string) => u.split(/[?#]/)[0].replace(/\/$/, "");
  return strip(a) === strip(b);
}

/** Every page in the index that defines this handle, for diagnosing collisions. */
export function pagesWithHandle(index: AvrIndex, handle: string): string[] {
  return index.pages.filter((p) => p.elements.some((e) => e.handle === handle)).map((p) => p.url);
}

export function isHandle(target: unknown): target is string {
  return typeof target === "string" && /^@e\d+$/.test(target.trim());
}

export function isTextTarget(target: unknown): target is TextTarget {
  if (typeof target !== "object" || target === null || "boundingBox" in target) return false;
  const t = target as TextTarget;
  return (typeof t.text === "string" || t.text instanceof RegExp) && typeof (t as { role?: unknown }).role !== "string";
}

export function isRoleTarget(target: unknown): target is RoleTarget {
  if (typeof target !== "object" || target === null || "boundingBox" in target) return false;
  const t = target as RoleTarget;
  return typeof t.role === "string" && (typeof t.name === "string" || t.name instanceof RegExp);
}

/**
 * Candidate locators for an entry, most durable first. The resolver tries each in
 * order and uses the first that matches exactly one element.
 */
export function candidateLocators(page: Page, entry: IndexEntry, within?: string | Locator): { how: string; locator: Locator }[] {
  const scope = within ? (typeof within === "string" ? page.locator(within).first() : within) : page;
  const out: { how: string; locator: Locator }[] = [];
  const nth = Math.max(1, entry.nth);

  if (entry.stable) {
    const v = entry.stable.value;
    if (entry.stable.kind === "id") out.push({ how: `id=${v}`, locator: scope.locator(`#${cssEscape(v)}`) });
    else if (entry.stable.kind === "aria-label")
      out.push({ how: `aria-label=${v}`, locator: scope.locator(`[aria-label="${attrEscape(v)}"]`) });
    else if (entry.stable.kind === "placeholder")
      out.push({ how: `placeholder=${v}`, locator: scope.locator(`[placeholder="${attrEscape(v)}"]`) });
    else out.push({ how: `${entry.stable.kind}=${v}`, locator: scope.locator(`[${entry.stable.kind}="${attrEscape(v)}"]`) });
  }

  // role + name, exact then substring.
  out.push({ how: `getByRole(${entry.role}, ${JSON.stringify(entry.name)})`, locator: scope.getByRole(entry.role as any, { name: entry.name, exact: true }).nth(nth - 1) });
  if (entry.name) {
    out.push({ how: `getByRole(${entry.role}, /${truncate(entry.name)}/i)`, locator: scope.getByRole(entry.role as any, { name: new RegExp(escapeRe(truncate(entry.name)), "i") }).nth(Math.max(0, nth - 1)) });
    out.push({ how: `getByText(${JSON.stringify(entry.name)})`, locator: scope.getByText(entry.name, { exact: true }).nth(Math.max(0, nth - 1)) });
  }
  return out;
}

/**
 * Roles whose accessible name comes from their content. For every other role, pointing at
 * the text is the reliable address: `role: "status"` has no name to match on.
 */
const NAME_FROM_CONTENT = new Set([
  "button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "listitem",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader",
  "sectionhead", "switch", "tab", "term", "tooltip", "treeitem", "definition",
]);

/** The address a scenario should use for this element. */
export function suggestedTarget(
  el: { handle?: string; role: string; name: string; nameFrom: string },
  nth = 1,
): Target {
  const takesNameFromContent =
    NAME_FROM_CONTENT.has(el.role) ||
    el.nameFrom === "aria-label" ||
    el.nameFrom === "label" ||
    el.nameFrom === "placeholder";

  // A live region that has not filled in yet has no name and no text. Its handle is the
  // only stable address, and it keeps working once the region populates.
  if (!el.name) {
    if (el.handle) return el.handle;
    const t: { role: string; name: string; nth?: number } = { role: el.role, name: el.name };
    if (nth > 1) t.nth = nth;
    return t;
  }

  if (takesNameFromContent) {
    const t: { role: string; name: string; nth?: number } = { role: el.role, name: el.name };
    if (nth > 1) t.nth = nth;
    return t;
  }
  const t: { text: string; nth?: number } = { text: el.name };
  if (nth > 1) t.nth = nth;
  return t;
}

/**
 * The address a scenario can keep using, independent of CSS. Uses the element's own
 * suggested address so a live region is addressed by text and a button by role+name.
 */
export function addressOf(entry: IndexEntry): RoleTarget {
  if (entry.target && typeof entry.target === "object" && "role" in entry.target) {
    return entry.target as RoleTarget;
  }
  const t: RoleTarget = { role: entry.role, name: entry.name };
  if (entry.nth > 1) t.nth = entry.nth;
  return t;
}

/** The address for an index entry, in whatever form it takes. */
export function targetOf(entry: IndexEntry): Target {
  return entry.target ?? addressOf(entry);
}

/**
 * Fill in `target` for entries written by an older version, so an index produced before
 * this field existed keeps resolving.
 */
export function normalizeIndex(index: AvrIndex): AvrIndex {
  let changed = false;
  const pages = index.pages.map((p) => {
    const elements = p.elements.map((e) => {
      if (e.target) return e;
      changed = true;
      return { ...e, target: suggestedTarget({ ...e, handle: e.handle }, e.nth) };
    });
    return { ...p, elements };
  });
  return changed ? { ...index, pages } : index;
}

export function describeEntry(entry: IndexEntry): string {
  const n = entry.nth > 1 ? ` #${entry.nth}` : "";
  return `${entry.handle} ${entry.role}${n} "${truncate(entry.name, 42)}"`;
}

/**
 * Resolve a role+name target, reporting ambiguity with sibling positions instead of
 * silently acting on the first match.
 */
export async function resolveRoleTarget(page: Page, t: RoleTarget): Promise<{ locator: Locator; how: string }> {
  const scope = t.within ? (typeof t.within === "string" ? page.locator(t.within).first() : t.within) : page;
  const nameStr = nameToText(t.name);

  // A RegExp name is an explicit request for a group, so ambiguity is the point.
  if (t.name instanceof RegExp) {
    const loc = scope.getByRole(t.role as any, { name: t.name });
    const count = await loc.count();
    const how = `getByRole(${t.role}, ${t.name})`;
    if (count === 0) throw new Error(`No element matched ${how}.\n${await nearMissReport(page, t.role, nameStr)}`);
    if (t.near) return nearOf(loc, t.near, how, count);
    return { locator: t.nth !== undefined ? loc.nth(t.nth - 1) : loc.first(), how: `${how} (${count} matches)` };
  }

  const exact = t.exact ?? true;
  let loc = scope.getByRole(t.role as any, { name: t.name, exact });
  let count = await loc.count();
  let how = `getByRole(${t.role}, ${JSON.stringify(t.name)})`;

  if (count === 0 && exact) {
    loc = scope.getByRole(t.role as any, { name: new RegExp(escapeRe(truncate(nameStr)), "i") });
    count = await loc.count();
    how = `getByRole(${t.role}, /${truncate(nameStr)}/i)`;
  }
  if (count === 0) {
    throw new Error(`No element matched ${how}.\n${await nearMissReport(page, t.role, nameStr)}`);
  }
  if (t.near) return nearOf(loc, t.near, how, count);
  if (t.nth !== undefined) {
    if (t.nth > count) throw new Error(`${how} matched ${count} elements; nth=${t.nth} is out of range.`);
    return { locator: loc.nth(t.nth - 1), how: `${how} nth=${t.nth}` };
  }
  if (count > 1) {
    const { lines, hint } = await ambiguityLines(loc, await matchesOf(loc), () => "");
    throw new Error(`${how} matched ${count} elements.\n  ${lines}\n${hint}, pass a RegExp name to address the group, or use "within" to scope the search.`);
  }
  return { locator: loc.first(), how };
}

/** Apply a `near` tie-break to a set of matches. */
async function nearOf(loc: Locator, near: string, how: string, count: number): Promise<{ locator: Locator; how: string }> {
  const i = await pickNear(loc, near);
  if (i < 0) {
    const marks = (await distinguish(loc)).filter(Boolean);
    throw new Error(
      `${how} matched ${count} elements, but none of them has ${JSON.stringify(near)} next to it.` +
        (marks.length ? `\n  Text that does set them apart: ${marks.map((m) => JSON.stringify(m)).join(", ")}` : ""),
    );
  }
  return { locator: loc.nth(i), how: `${how} near ${JSON.stringify(near)}` };
}

/** Resolve a text target the same way role targets resolve: exact, then tolerant. */
export async function resolveTextTarget(page: Page, t: TextTarget): Promise<{ locator: Locator; how: string }> {
  const scope = t.within ? (typeof t.within === "string" ? page.locator(t.within).first() : t.within) : page;
  const text = t.text instanceof RegExp ? t.text : t.text;
  let loc = scope.getByText(text as any, { exact: t.exact ?? (t.text instanceof RegExp ? false : true) });
  let count = await loc.count();
  let how = `getByText(${t.text instanceof RegExp ? t.text : JSON.stringify(t.text)})`;

  if (count === 0) {
    const loose = typeof t.text === "string" ? new RegExp(escapeRe(truncate(t.text)), "i") : t.text;
    loc = scope.getByText(loose as any, { exact: false });
    count = await loc.count();
    how = `getByText(/${text instanceof RegExp ? text.source : escapeRe(truncate(String(text)))}/i)`;
  }
  if (count === 0) throw new Error(`No element matched ${how}.\n${await nearMissReport(page, "", nameToText(t.text))}`);
  if (t.near) return nearOf(loc, t.near, how, count);
  if (t.nth !== undefined) {
    if (t.nth > count) throw new Error(`${how} matched ${count} elements; nth=${t.nth} is out of range.`);
    return { locator: loc.nth(t.nth - 1), how: `${how} nth=${t.nth}` };
  }
  if (count > 1) {
    const { lines, hint } = await ambiguityLines(loc, await matchesOf(loc), (m) => ` "${truncate(m.name, 40)}"`);
    throw new Error(`${how} matched ${count} elements.\n  ${lines}\n${hint}, or use "within" to scope the search.`);
  }
  return { locator: loc.first(), how };
}

/**
 * Every element matching a target, so a script can act on a group instead of one element.
 * `{ role: "button", name: /^Delete/ }` answers "which delete buttons are on this page".
 */
export async function findAllRoleTargets(page: Page, t: RoleTarget): Promise<Match[]> {
  const scope = t.within ? (typeof t.within === "string" ? page.locator(t.within).first() : t.within) : page;
  const name = t.name instanceof RegExp ? t.name : t.exact === false ? new RegExp(escapeRe(truncate(nameToText(t.name))), "i") : t.name;
  const loc = scope.getByRole(t.role as any, { name });
  const matches = await matchesOf(loc);
  return matches.map((m) => ({ ...m }));
}


/**
 * Among several matches, the one that shares the smallest container with `near`. The right
 * card holds both the element and the text; every other match only meets that text higher
 * up, in a container that also holds more of the matches.
 */
export async function pickNear(loc: Locator, near: string): Promise<number> {
  return loc.evaluateAll((els, wanted) => {
    const want = wanted.toLowerCase();
    let best = -1;
    let bestScore = [Infinity, Infinity];
    els.forEach((el, i) => {
      let depth = 0;
      for (let p: Element | null = el; p; p = p.parentElement, depth++) {
        if (!((p as HTMLElement).innerText || p.textContent || "").toLowerCase().includes(want)) continue;
        const inside = els.filter((o) => p!.contains(o)).length;
        if (inside < bestScore[0] || (inside === bestScore[0] && depth < bestScore[1])) {
          best = i;
          bestScore = [inside, depth];
        }
        break;
      }
    });
    // A container holding every match says nothing about which one is meant.
    return els.length > 1 && bestScore[0] >= els.length ? -1 : best;
  }, near);
}

/**
 * For each match, a line of text that only its own card contains. This is what tells
 * three identical "Store" headings apart: each card also shows its own id.
 */
export async function distinguish(loc: Locator): Promise<(string | undefined)[]> {
  return loc
    .evaluateAll((els) => {
      const cards = els.map((el) => {
        let card: Element = el;
        while (card.parentElement && !els.some((o) => o !== el && card.parentElement!.contains(o))) card = card.parentElement;
        return ((card as HTMLElement).innerText || "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length >= 2 && l.length <= 48);
      });
      return cards.map((lines, i) => {
        const others = new Set(cards.flatMap((c, j) => (j === i ? [] : c)));
        const own = lines.filter((l) => !others.has(l));
        // Ids and slugs make the steadiest anchors; numbers that look like live metrics do not.
        return own.find((l) => /^[\w.-]*[a-z][\w.-]*[-_.\d][\w.-]*$/i.test(l)) ?? own.find((l) => !/^[\d.,:%\s]+\w{0,3}$/.test(l));
      });
    })
    .catch(() => []);
}

/** The ambiguity message, with what sets each match apart when something does. */
async function ambiguityLines(loc: Locator, matches: Match[], label: (m: Match) => string): Promise<{ lines: string; hint: string }> {
  const marks = await distinguish(loc);
  const lines = matches.map((m, i) => `nth=${m.nth}${label(m)} at (${m.x},${m.y})${marks[i] ? `  near ${JSON.stringify(marks[i])}` : ""}`).join("\n  ");
  const hint = marks.some(Boolean)
    ? `Add near: "<text>" to pick one by what is next to it (steadier than nth, which depends on order)`
    : `Add "nth" to choose one`;
  return { lines, hint };
}

function nameToText(name: string | RegExp): string {
  return typeof name === "string" ? name : name.source;
}

/** Match positions in visual order, with the role and name each carries. */
async function matchesOf(loc: Locator): Promise<Match[]> {
  const n = await loc.count();
  const out: Match[] = [];
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    const box = await el.boundingBox().catch(() => null);
    const meta = await el
      .evaluate((node) => ({
        role: node.getAttribute("role") || node.tagName.toLowerCase(),
        name: (node.getAttribute("aria-label") || (node as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 60),
      }))
      .catch(() => ({ role: "", name: "" }));
    out.push({
      nth: i + 1,
      role: meta.role,
      name: meta.name,
      x: box ? Math.round(box.x) : -1,
      y: box ? Math.round(box.y) : -1,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
    });
  }
  return out;
}

/** Element positions in visual order, for ambiguity messages. */
async function positionsOf(loc: Locator): Promise<{ x: number; y: number }[]> {
  const n = await loc.count();
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const box = await loc.nth(i).boundingBox().catch(() => null);
    out.push(box ? { x: Math.round(box.x), y: Math.round(box.y) } : { x: -1, y: -1 });
  }
  return out;
}

/**
 * When a lookup fails, take a fresh inventory of the page and suggest the closest
 * live elements. This is what turns a 40s opaque timeout into one line of advice.
 */
export async function nearMissReport(page: Page, wantedRole: string, wantedName: string, limit = 5): Promise<string> {
  const { collectInventory } = await import("./inventory.js");
  let page_inv: InventoryPage;
  try {
    page_inv = (await page.evaluate(collectInventory, { max: 250, scroll: false })) as InventoryPage;
  } catch (e) {
    return `  (could not inventory the page: ${(e as Error).message})`;
  }
  const scored = page_inv.elements
    .map((el) => ({ el, score: similarity(`${el.role} ${el.name}`, `${wantedRole} ${wantedName}`) }))
    .filter((s) => s.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  // A missing element is often a wrong page (login redirect, "not found", error boundary),
  // which only the page's text reveals.
  const { pageGist, formatGist } = await import("./observe.js");
  const gist = formatGist(page_inv.url, await pageGist(page));
  if (!scored.length) {
    return `  Nothing similar is on ${page_inv.url}.\n${gist}`;
  }
  return [
    `  Closest elements on ${page_inv.url}:`,
    ...scored.map((s) => `    ${s.el.handle} ${s.el.role} "${truncate(s.el.name, 48)}" at (${s.el.x},${s.el.y})`),
    gist,
  ].join("\n");
}

function similarity(a: string, b: string): number {
  const at = new Set(tokenize(a));
  const bt = new Set(tokenize(b));
  if (!at.size || !bt.size) return 0;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  return shared / Math.max(at.size, bt.size);
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) : s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attrEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

function cssEscape(s: string): string {
  return s.replace(/([^\w-])/g, "\\$1");
}
