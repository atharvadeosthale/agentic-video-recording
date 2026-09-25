/**
 * Observations: a compact reading of what a page shows right now, and the difference
 * between two readings. This is what lets an agent act and see the result in one call,
 * instead of re-inventorying a page after every click.
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { collectInventory, type InventoryElement, type InventoryPage } from "./inventory.js";

export interface PageGist {
  /** Accessible name of the open modal dialog, if any. */
  dialog: { name: string; x: number; y: number; width: number; height: number } | null;
  headings: string[];
  /** Text of alert, status and toast regions. */
  alerts: string[];
  /** First lines of visible body text, for pages with nothing interactive (errors, empty states). */
  body: string;
  /** Role and name of the focused element. */
  focus: string;
  /** Concatenated form values, so typing changes the fingerprint. */
  values: string;
}

export interface Observation extends PageGist {
  url: string;
  title: string;
  /** Interactive elements in the top layer: inside the dialog when one is open. */
  elements: InventoryElement[];
  /** Elements behind an open dialog, left out of `elements`. */
  behind: number;
  /** Hash of everything above. Two equal fingerprints mean the page is in the same state. */
  fingerprint: string;
}

/** Runs inside the page. Everything about the page that is not an interactive element. */
const collectGist = (): PageGist => {
  const vis = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
    return r;
  };
  const text = (el: Element, n = 120) => ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, n);

  let dialog: PageGist["dialog"] = null;
  for (const el of Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))) {
    const r = vis(el);
    if (!r) continue;
    const labelled = el.getAttribute("aria-labelledby");
    const name =
      el.getAttribute("aria-label") ||
      (labelled ? text(document.getElementById(labelled.split(/\s+/)[0]) ?? el, 80) : "") ||
      text(el.querySelector("h1, h2, h3, [role=heading]") ?? el, 80);
    // The last visible dialog in DOM order is the one on top.
    dialog = { name, x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  }

  const headings: string[] = [];
  for (const el of Array.from(document.querySelectorAll("h1, h2, h3, [role=heading]"))) {
    if (!vis(el)) continue;
    const t = text(el, 80);
    if (t && !headings.includes(t)) headings.push(t);
    if (headings.length >= 12) break;
  }

  const alerts: string[] = [];
  for (const el of Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live], [data-sonner-toast], .toast, [class*="toast" i]'))) {
    if (!vis(el)) continue;
    const t = text(el, 160);
    if (t && !alerts.includes(t)) alerts.push(t);
    if (alerts.length >= 6) break;
  }

  const active = document.activeElement;
  // Only text entry counts: focus on a link or button says nothing about page state.
  const typable = !!active && (/^(input|textarea|select)$/i.test(active.tagName) || (active as HTMLElement).isContentEditable);
  const focus =
    active && typable
      ? `${active.getAttribute("role") || active.tagName.toLowerCase()} ${active.getAttribute("aria-label") || active.getAttribute("name") || active.getAttribute("placeholder") || ""}`.trim()
      : "";

  const values = Array.from(document.querySelectorAll("input, textarea, select"))
    .map((el) => {
      const i = el as HTMLInputElement;
      if (i.type === "password") return "*".repeat(i.value.length);
      if (i.type === "checkbox" || i.type === "radio") return i.checked ? "1" : "0";
      return i.value;
    })
    .join("");

  return { dialog, headings, alerts, body: text(document.body, 400), focus, values };
};

/** Read the page: top-layer interactive elements plus the gist, with a state fingerprint. */
export async function observe(page: Page, opts: { max?: number } = {}): Promise<Observation> {
  const inv = (await page.evaluate(collectInventory, { max: opts.max ?? 250, scroll: false })) as InventoryPage;
  const gist = await page.evaluate(collectGist);
  let elements = inv.elements;
  let behind = 0;
  if (gist.dialog) {
    const d = gist.dialog;
    const inside = elements.filter((e) => {
      const cx = e.x + e.width / 2, cy = e.y + e.height / 2;
      return cx >= d.x && cx <= d.x + d.width && cy >= d.y && cy <= d.y + d.height;
    });
    // A dialog with nothing interactive inside it is more likely a mis-detected wrapper.
    if (inside.length) {
      behind = elements.length - inside.length;
      elements = inside;
    }
  }
  elements = numberElements(elements);
  const url = page.url();
  const fingerprint = createHash("sha1")
    .update(
      JSON.stringify([
        url.split("#")[0],
        gist.dialog?.name ?? "",
        elements.map((e) => `${e.role}|${e.name}|${e.disabled ? 1 : 0}|${e.state ?? ""}`),
        gist.headings,
        gist.values,
        gist.focus,
      ]),
    )
    .digest("hex")
    .slice(0, 12);
  return { ...gist, url, title: inv.title, elements, behind, fingerprint };
}

/**
 * Give every element the number the agent sees in the view and on its screenshot. Regions
 * are kept together, in the order they first appear on the page, so the numbers read like
 * the page does: header, navigation, then content.
 */
export function numberElements(els: InventoryElement[]): InventoryElement[] {
  const listed = els.filter(listable);
  const first = new Map<string, number>();
  listed.forEach((e, i) => {
    const r = e.region ?? "page";
    if (!first.has(r)) first.set(r, i);
  });
  const numbered = listed
    .map((e, i) => ({ e, i }))
    .sort((a, b) => first.get(a.e.region ?? "page")! - first.get(b.e.region ?? "page")! || a.i - b.i)
    .map(({ e }, i) => ({ ...e, label: i + 1 }));
  // Containers stay addressable by name (zoom onto a card), they just get no number.
  return [...numbered, ...els.filter((e) => !listable(e))];
}

/** Roles a person acts on or reads as a landmark. Containers repeat their whole text and only add noise. */
const LISTED = new Set([
  "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch",
  "combobox", "treeitem", "row", "textbox", "searchbox", "spinbutton", "slider", "heading", "status", "alert",
  "gridcell", "columnheader", "tooltip", "img",
]);
const listable = (e: InventoryElement) =>
  LISTED.has(e.role) && (e.role !== "img" || !!e.name) && e.width > 2 && e.height > 2;

/** The page gist alone, for error messages. Never throws. */
export async function pageGist(page: Page): Promise<PageGist | null> {
  try {
    return await page.evaluate(collectGist);
  } catch {
    return null;
  }
}

const key = (e: InventoryElement) => `${e.role}|${e.name}`;
const short = (s: string, n = 56) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const fmtEl = (e: InventoryElement) => `${e.role} ${JSON.stringify(short(e.name))}${e.disabled ? " (disabled)" : ""}`;

/** A path in full, a long query string cut: the path says where a link goes. */
const shortHref = (h: string) => {
  const q = h.indexOf("?");
  return q < 0 ? short(h, 80) : short(h.slice(0, q), 60) + (h.length - q > 24 ? `${h.slice(q, q + 20)}…` : h.slice(q));
};

/** One element as the agent reads it: number, what it is, and what the markup says it does. */
export function fmtLabeled(e: InventoryElement, opts: { number?: boolean } = {}): string {
  const bits = [opts.number !== false && e.label ? String(e.label) : "", e.role, e.name ? JSON.stringify(short(e.name)) : ""];
  if (e.icon) bits.push(`[icon ${e.icon}]`);
  if (e.state) bits.push(`[${e.state}]`);
  if (e.href) bits.push(`→ ${shortHref(e.href)}`);
  if (e.opens) bits.push(`(opens ${e.opens})`);
  if (e.disabled) bits.push("(disabled)");
  if (e.covered) bits.push(`(covered by ${e.covered})`);
  if (e.offscreen) bits.push(e.offscreen === "below" ? "↓" : e.offscreen === "above" ? "↑" : e.offscreen === "left" ? "←" : "→offscreen");
  return bits.filter(Boolean).join(" ");
}

/** What changed between two observations, as lines an agent can read at a glance. */
export function diffObservations(a: Observation, b: Observation, limit = 14): string[] {
  const out: string[] = [];
  if (a.url !== b.url) out.push(`url: ${pathOf(a.url)} -> ${pathOf(b.url)}`);
  if ((a.dialog?.name ?? null) !== (b.dialog?.name ?? null)) {
    if (b.dialog && !a.dialog) out.push(`dialog opened: ${JSON.stringify(b.dialog.name)} (${b.behind} elements behind it are hidden from this list)`);
    else if (!b.dialog && a.dialog) out.push(`dialog closed: ${JSON.stringify(a.dialog.name)}`);
    else out.push(`dialog: ${JSON.stringify(a.dialog?.name)} -> ${JSON.stringify(b.dialog?.name)}`);
  }

  const count = (els: InventoryElement[]) => {
    const m = new Map<string, number>();
    for (const e of els) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
    return m;
  };
  const before = count(a.elements), after = count(b.elements);
  const added = b.elements.filter((e) => (after.get(key(e)) ?? 0) > (before.get(key(e)) ?? 0));
  const removed = a.elements.filter((e) => (before.get(key(e)) ?? 0) > (after.get(key(e)) ?? 0));
  const uniq = (els: InventoryElement[]) => [...new Map(els.map((e) => [key(e), e])).values()];

  const navigated = a.url.split(/[?#]/)[0] !== b.url.split(/[?#]/)[0];
  if (navigated && added.length > limit) {
    // A whole new page: the diff is the page. Summarize and point at `takeone look`.
    out.push(`new page: ${b.elements.length} elements (run \`takeone look\` to list them)`);
  } else {
    const add = uniq(added), rem = uniq(removed);
    for (const e of add.slice(0, limit)) out.push(`+ ${fmtLabeled(e)}`);
    if (add.length > limit) out.push(`+ … ${add.length - limit} more (takeone look)`);
    if (rem.length <= 6) for (const e of rem) out.push(`- ${fmtEl(e)}`);
    else out.push(`- ${rem.length} elements removed`);
  }

  // Same element, different enabled state: the usual sign a form became submittable.
  const wasDisabled = new Set(a.elements.filter((e) => e.disabled).map(key));
  for (const e of b.elements) if (!e.disabled && wasDisabled.has(key(e))) out.push(`~ ${fmtLabeled(e)} is now enabled`);
  // A toggle, tab or field whose state changed: same element, different reading.
  const onceBefore = new Map([...before].filter(([, n]) => n === 1).map(([k]) => [k, a.elements.find((e) => key(e) === k)!]));
  for (const e of b.elements) {
    const was = after.get(key(e)) === 1 ? onceBefore.get(key(e)) : undefined;
    if (was && (was.state ?? "") !== (e.state ?? "") && !/^= /.test(e.state ?? "")) out.push(`~ ${e.label ?? ""} ${e.role} ${JSON.stringify(short(e.name))} now [${e.state ?? "no state"}]`.replace("~  ", "~ "));
  }

  const newHeadings = b.headings.filter((h) => !a.headings.includes(h));
  if (newHeadings.length) out.push(`headings+: ${newHeadings.slice(0, 5).map((h) => JSON.stringify(short(h))).join(", ")}`);
  const newAlerts = b.alerts.filter((h) => !a.alerts.includes(h));
  for (const al of newAlerts.slice(0, 3)) out.push(`alert: ${JSON.stringify(short(al, 140))}`);
  if (a.values !== b.values && a.url === b.url) out.push("form values changed");
  if (a.focus !== b.focus && b.focus) out.push(`focus: ${b.focus}`);
  return out;
}

/**
 * The page as the agent reads it: every element numbered, grouped by the region it sits in,
 * with what the markup says each one does. The same numbers are drawn on the view's
 * screenshot, and `takeone do click 12` acts on number 12.
 */
export function formatObservation(o: Observation, opts: { role?: string; filter?: string; max?: number; all?: boolean } = {}): string[] {
  const out: string[] = [`${pathOf(o.url)}  "${short(o.title, 60)}"`];
  if (o.dialog) out.push(`dialog open: ${JSON.stringify(o.dialog.name)}. Only what is inside it is listed (${o.behind} elements behind it).`);
  for (const al of o.alerts.slice(0, 3)) out.push(`alert: ${JSON.stringify(short(al, 140))}`);
  const f = opts.filter?.toLowerCase();
  const matching = o.elements.filter((e) => e.label && (!opts.role || e.role === opts.role) && (!f || e.name.toLowerCase().includes(f) || (e.icon ?? "").includes(f)));
  // Like a person looking at the screen: what is visible, in full. What is scrolled away is
  // summarised, unless asked for or searched for.
  const all = opts.all || !!f || !!opts.role;
  const els = all ? matching : matching.filter((e) => !e.offscreen);
  const away = all ? [] : matching.filter((e) => e.offscreen);
  const max = opts.max ?? 160;
  let shown = 0;
  let region: string | undefined;
  for (let i = 0; i < els.length && shown < max; i++) {
    const e = els[i];
    // A heading that is also the link next to it (a list of titles) reads once, as the link.
    const twin = (x?: InventoryElement) => !!x && x.name === e.name && x.role !== "heading";
    if (e.role === "heading" && (twin(els[i - 1]) || twin(els[i + 1]))) continue;
    if (e.region !== region) {
      region = e.region;
      out.push(region ?? "page");
    }
    // A run of identical controls (a menu button on every row) reads as one line.
    let j = i;
    while (j + 1 < els.length && els[j + 1].region === e.region && key(els[j + 1]) === key(e) && !els[j + 1].href && !e.href) j++;
    if (j - i >= 3) {
      out.push(`  ${e.label}-${els[j].label} ${fmtLabeled(e, { number: false })} ×${j - i + 1}`);
      i = j;
    } else out.push(`  ${fmtLabeled(e)}`);
    shown++;
  }
  if (shown >= max && els.length > max) out.push(`… more below. Narrow it: --filter <text> or --role <role>`);
  if (!els.length) out.push(`  (no interactive elements${opts.role || f ? " match the filter" : ""}) text: ${JSON.stringify(short(o.body, 200))}`);
  if (away.length) {
    const heads = away.filter((e) => e.role === "heading").slice(0, 12);
    out.push(`off screen: ${away.length} more elements${heads.length ? `. Headings: ${heads.map((h) => `${h.label} ${JSON.stringify(short(h.name, 40))}`).join(", ")}` : ""}`);
    out.push("  `scroll-to <n>` brings one into view; `look --all` lists them.");
  } else if (els.some((e) => e.offscreen)) out.push("↓/↑ = off screen; `scroll-to <n>` brings it into view.");
  return out;
}

/** Lines describing what the page says, for failures where no element matched. */
export function formatGist(url: string, g: PageGist | null): string {
  if (!g) return "";
  const lines = [`  The page at ${pathOf(url)} shows:`];
  if (g.dialog) lines.push(`    dialog: ${JSON.stringify(g.dialog.name)}`);
  if (g.headings.length) lines.push(`    headings: ${g.headings.slice(0, 6).map((h) => JSON.stringify(short(h, 40))).join(", ")}`);
  for (const al of g.alerts.slice(0, 3)) lines.push(`    alert: ${JSON.stringify(short(al, 140))}`);
  if (g.body) lines.push(`    text: ${JSON.stringify(short(g.body, 220))}`);
  if (/\/(sign-?in|log-?in|auth)\b/i.test(url)) lines.push("    This looks like a login page: the browser is probably not authenticated.");
  if (/not found|something went wrong|application error|unexpected error|\b404\b|\b500\b/i.test(`${g.headings.join(" ")} ${g.body.slice(0, 200)}`))
    lines.push("    This looks like an error page, not a missing element. Check the URL and any IDs in it.");
  return lines.join("\n");
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}
