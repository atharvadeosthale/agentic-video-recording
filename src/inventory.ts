/**
 * Element inventory: give every interactive element a stable short handle so an
 * agent can point at `@e12` instead of guessing a CSS selector.
 */

/** One addressable element on the page. */
export interface InventoryElement {
  /** Stable short handle, e.g. "@e12". Deterministic for the same page state. */
  handle: string;
  tag: string;
  role: string;
  /** Accessible name: aria-label, label, placeholder, title, alt, or text. */
  name: string;
  /** How the name was derived, so an agent knows how durable it is. */
  nameFrom: string;
  disabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A durable attribute if the element has one (id, data-testid, name, ...). */
  stable?: { kind: string; value: string };
  /** Present when the same role+name matches more than one element. */
  ambiguousWith?: string[];
}

export interface InventoryPage {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scrollHeight: number;
  elements: InventoryElement[];
  /** Elements whose role+name was not unique, with a suggested disambiguator. */
  ambiguous: { handle: string; role: string; name: string; count: number; suggestion: string }[];
  /** True when the page was taller than the viewport and more elements exist off-screen. */
  truncated: boolean;
}

export interface InventoryBundle {
  version: 1;
  createdAt: string;
  pages: InventoryPage[];
  /** Screenshot with handle chips burned in, per page. */
  sheets?: { url: string; file: string }[];
}

/**
 * Runs inside the page. Walks interactive elements in visual order and reports the
 * best available address for each. Kept dependency-free so it can be dropped into
 * any Playwright page.
 */
export const collectInventory = ({ max, scroll }: { max: number; scroll: boolean }) => {
  const implicitRole = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "range") return "slider";
      if (type === "file") return "button";
      if (["text", "email", "password", "search", "tel", "url", "number", ""].includes(type)) return "textbox";
      return null;
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return null;
  };

  const nameOf = (el: Element): { name: string; from: string } => {
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return { name: al.trim(), from: "aria-label" };
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (t) return { name: t, from: "aria-labelledby" };
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = lab?.textContent?.replace(/\s+/g, " ").trim();
      if (t) return { name: t, from: "label" };
    }
    const wrapped = el.closest("label");
    const wt = wrapped?.textContent?.replace(/\s+/g, " ").trim();
    if (wt) return { name: wt, from: "label" };
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return { name: ph.trim(), from: "placeholder" };
    const ti = el.getAttribute("title");
    if (ti && ti.trim()) return { name: ti.trim(), from: "title" };
    const img = el.querySelector("img[alt]");
    if (img?.getAttribute("alt")?.trim()) return { name: img.getAttribute("alt")!.trim(), from: "img-alt" };
    const txt = ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return { name: txt.slice(0, 80), from: "text" };
  };

  /**
   * Status and alert regions take their name from live content. An empty one has no name
   * yet, which is a normal transient state rather than a failure.
   */
  const isLiveRegion = (el: Element): boolean => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["status", "alert", "log", "marquee", "timer"].includes(role)) return true;
    return el.hasAttribute("aria-live");
  };

  const stableOf = (el: Element): { kind: string; value: string } | undefined => {
    if (el.id && !/^radix-|^headlessui-|^:r/.test(el.id)) return { kind: "id", value: el.id };
    for (const a of ["data-testid", "data-test-id", "data-test", "data-cy", "name", "aria-label", "placeholder"]) {
      const v = el.getAttribute(a);
      if (v && v.trim()) return { kind: a, value: v.trim() };
    }
    return undefined;
  };

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
    return r;
  };

  const selector = "a[href], button, input, select, textarea, [role], summary, h1, h2, h3";
  const seen = new Set<Element>();
  const found: { el: Element; r: DOMRect; role: string; name: string; nameFrom: string }[] = [];

  const scan = () => {
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (seen.has(el)) continue;
      const r = visible(el);
      if (!r) continue;
      const role = implicitRole(el);
      if (!role) continue;
      seen.add(el);
      const { name, from } = nameOf(el);
      const live = isLiveRegion(el);
      found.push({
        el,
        r,
        role,
        name,
        nameFrom: live && from === "text" ? "live-text" : from,
      });
    }
  };

  // Walk the page so off-screen elements are included, then restore scroll.
  const restoreY = window.scrollY;
  scan();
  if (scroll) {
    const step = Math.round(window.innerHeight * 0.8);
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    for (let y = step; y <= maxY; y += step) {
      window.scrollTo(0, y);
      scan();
    }
    window.scrollTo(0, restoreY);
  }

  const pageRect = { top: window.scrollY, left: window.scrollX };
  found.sort((a, b) => {
    const ay = a.r.top + pageRect.top, by = b.r.top + pageRect.top;
    if (Math.abs(ay - by) > 8) return ay - by;
    return a.r.left - b.r.left;
  });

  const counts = new Map<string, number>();
  for (const f of found) {
    const k = `${f.role}::${f.name.toLowerCase()}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  const elements = found.slice(0, max).map((f, i) => {
    const handle = `@e${i + 1}`;
    const k = `${f.role}::${f.name.toLowerCase()}`;
    const count = counts.get(k) || 1;
    const stable = stableOf(f.el);
    return {
      handle,
      tag: f.el.tagName.toLowerCase(),
      role: f.role,
      name: f.name,
      nameFrom: f.nameFrom,
      disabled: (f.el as HTMLButtonElement).disabled === true || f.el.getAttribute("aria-disabled") === "true",
      x: Math.round(f.r.left),
      y: Math.round(f.r.top),
      width: Math.round(f.r.width),
      height: Math.round(f.r.height),
      stable,
      ambiguousWith: count > 1 ? [`${count} elements share role+name`] : undefined,
    };
  });

  const nthOf = new Map<string, number>();
  const ambiguous = elements
    .filter((e) => e.ambiguousWith)
    .map((e) => {
      const key = `${e.role}::${e.name.toLowerCase()}`;
      const n = (nthOf.get(key) ?? 0) + 1;
      nthOf.set(key, n);
      const howMany = counts.get(key) || 1;
      const suggestion =
        `{"role":"${e.role}","name":"${e.name}","nth":${n}}` +
        (e.stable ? `  (or ${e.stable.kind}=${e.stable.value})` : "") +
        `  — ${howMany} share this role+name`;
      return { handle: e.handle, role: e.role, name: e.name, count: howMany, suggestion };
    });

  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollHeight: document.documentElement.scrollHeight,
    elements,
    ambiguous,
    truncated: found.length > max,
  };
};

/**
 * Build the disambiguation advice. Exported so the resolver can reuse the same wording
 * when an agent's target turns out to be ambiguous at run time.
 */
export function ambiguityHint(role: string, name: string, matches: { handle?: string; x: number; y: number }[]): string {
  if (matches.length <= 1) return "";
  const listed = matches
    .slice(0, 5)
    .map((m) => `${m.handle ?? "?"} at (${m.x},${m.y})`)
    .join(", ");
  return `"${role}" named "${name}" matched ${matches.length} elements: ${listed}. Add "nth" to pick one.`;
}
