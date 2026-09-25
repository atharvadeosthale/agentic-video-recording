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
  /** Landmark the element sits in: `nav "Project"`, `sidebar`, `main`, `dialog "Create"`, or `page`. */
  region?: string;
  /** Where a link goes: a path on this origin, or the full URL elsewhere. */
  href?: string;
  /** What the element says it opens (aria-haspopup): menu, dialog, listbox, … Read from markup, never by clicking. */
  opens?: string;
  /** Current state: on/off, selected, current, expanded/collapsed, pressed, or a field's value. */
  state?: string;
  /** Icon name read from the markup (lucide-trash-2, icon-plus, …), for buttons with little or no text. */
  icon?: string;
  /** What sits on top of the element's centre and would take a click there, when not the element itself. */
  covered?: string;
  /** Where the centre is relative to the viewport. Absent when it is on screen. */
  offscreen?: "above" | "below" | "left" | "right";
  /**
   * The element's first piece of text when its name is longer ("Issues" of "Issues 157",
   * "v1.64" of "v1.64 Popular"). The rest is often a live count or a badge.
   */
  lead?: string;
  /** Number shown in the live view and on its screenshot. Set by `observe`, not by the inventory. */
  label?: number;
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

  // Everything below reads markup only. Nothing is clicked, hovered or focused to learn it.
  const clean = (s: string | null | undefined, n = 40) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  const REGION =
    'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], nav, [role="navigation"], aside, [role="complementary"], [data-sidebar="sidebar"], main, [role="main"], header, [role="banner"], footer, [role="contentinfo"]';
  const regionOf = (el: Element): string => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (!p.matches(REGION)) continue;
      const tag = p.tagName.toLowerCase();
      const role = p.getAttribute("role");
      // A header or footer inside an article or card is part of that content, not the page chrome.
      if ((tag === "header" || tag === "footer") && !role && p.parentElement?.closest("main, article, section, aside, nav, dialog, [role=dialog]")) continue;
      const kind =
        tag === "nav" || role === "navigation" ? "nav"
        : tag === "aside" || role === "complementary" || p.hasAttribute("data-sidebar") ? "sidebar"
        : tag === "main" || role === "main" ? "main"
        : tag === "header" || role === "banner" ? "header"
        : tag === "footer" || role === "contentinfo" ? "footer"
        : role === "menu" ? "menu"
        : role === "listbox" ? "listbox"
        : "dialog";
      const lb = p.getAttribute("aria-labelledby");
      const label =
        clean(p.getAttribute("aria-label")) ||
        (lb ? clean(document.getElementById(lb.split(/\s+/)[0])?.textContent) : "") ||
        (kind === "dialog" || kind === "sidebar" ? clean(p.querySelector("h1, h2, h3, [role=heading]")?.textContent) : "");
      return label ? `${kind} "${label}"` : kind;
    }
    return "page";
  };

  const hrefOf = (el: Element): string | undefined => {
    const a = el.closest("a[href]") as HTMLAnchorElement | null;
    if (!a || !a.href || a.href.startsWith("javascript:")) return undefined;
    try {
      const u = new URL(a.href);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
    } catch {
      return undefined;
    }
  };

  const opensOf = (el: Element): string | undefined => {
    const hp = el.getAttribute("aria-haspopup");
    if (hp && hp !== "false") return hp === "true" ? "menu" : hp;
    return undefined;
  };

  const stateOf = (el: Element, role: string): string | undefined => {
    const parts: string[] = [];
    const checked = el.getAttribute("aria-checked") ?? ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio" ? String((el as HTMLInputElement).checked) : null);
    if (checked === "true") parts.push("on");
    else if (checked === "false" && ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) parts.push("off");
    else if (checked === "mixed") parts.push("mixed");
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    const cur = el.getAttribute("aria-current");
    if (cur && cur !== "false") parts.push("current");
    if (el.getAttribute("aria-pressed") === "true") parts.push("pressed");
    const exp = el.getAttribute("aria-expanded");
    if (exp === "true") parts.push("expanded");
    else if (exp === "false") parts.push("collapsed");
    const tag = el.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && !["checkbox", "radio", "button", "submit", "file"].includes((el as HTMLInputElement).type)) {
      const v = (el as HTMLInputElement).value;
      if (v) parts.push((el as HTMLInputElement).type === "password" ? "= ••••" : `= ${JSON.stringify(clean(v, 30))}`);
    } else if (tag === "select") {
      const o = (el as HTMLSelectElement).selectedOptions?.[0];
      if (o) parts.push(`= ${JSON.stringify(clean(o.textContent, 30))}`);
    }
    return parts.length ? parts.join(", ") : undefined;
  };

  const ICON = /(?:^|\s)(?:lucide-|icon-|octicon-|tabler-icon-|heroicon-[a-z]+-|mdi-|ph-|bi-|ri-|fa-)([a-z0-9-]+)/;
  const FA_STYLE = /^(solid|regular|light|thin|duotone|brands|sharp|lg|xs|sm|xl|[0-9]x|fw|spin|pulse)$/;
  const iconOf = (el: Element): string | undefined => {
    for (const c of [el, ...Array.from(el.querySelectorAll("svg, i, span[class*=icon], [data-icon], img")).slice(0, 6)]) {
      const di = c.getAttribute("data-icon") || c.getAttribute("data-lucide");
      if (di) return di;
      const cls = typeof (c as HTMLElement).className === "string" ? (c as HTMLElement).className : c.getAttribute("class") || "";
      for (const tok of cls.split(/\s+/)) {
        const m = ICON.exec(` ${tok}`);
        if (m && !FA_STYLE.test(m[1]) && m[1] !== "wrapper" && m[1] !== "button") return m[1];
      }
      if (c.tagName.toLowerCase() === "svg") {
        const t = clean(c.querySelector("title")?.textContent);
        if (t) return t;
      }
      if (/material-(icons|symbols)/.test(cls)) return clean(c.textContent);
    }
    return undefined;
  };

  const leadOf = (el: Element, name: string): string | undefined => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = clean(n.textContent, 80);
      if (!t) continue;
      return t.length < name.length && name.startsWith(t) ? t : undefined;
    }
    return undefined;
  };

  const describeTop = (t: Element): string => {
    const role = t.getAttribute("role") || implicitRole(t) || t.tagName.toLowerCase();
    const name = clean(t.getAttribute("aria-label") || (t as HTMLElement).innerText, 40);
    return name ? `${role} ${JSON.stringify(name)}` : `<${t.tagName.toLowerCase()}${t.className && typeof t.className === "string" ? ` class="${clean(t.className, 40)}"` : ""}>`;
  };
  const vw = window.innerWidth, vh = window.innerHeight;
  const placement = (el: Element): { offscreen?: "above" | "below" | "left" | "right"; covered?: string } => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cy < 0) return { offscreen: "above" };
    if (cy > vh) return { offscreen: "below" };
    if (cx < 0) return { offscreen: "left" };
    if (cx > vw) return { offscreen: "right" };
    const top = document.elementFromPoint(cx, cy);
    // Nothing there, the element itself, or an ancestor (a visually hidden heading, a
    // pointer-events:none label): none of these is something else in the way.
    if (!top || el === top || el.contains(top) || top.contains(el)) return {};
    // A label that forwards its click to this control is not in the way.
    const lab = top.closest("label");
    if (lab && (lab.contains(el) || (el.id && lab.htmlFor === el.id))) return {};
    return { covered: describeTop(top) };
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
    const r = scroll ? f.r : f.el.getBoundingClientRect();
    const where = scroll ? {} : placement(f.el);
    return {
      handle,
      tag: f.el.tagName.toLowerCase(),
      role: f.role,
      name: f.name,
      nameFrom: f.nameFrom,
      disabled: (f.el as HTMLButtonElement).disabled === true || f.el.getAttribute("aria-disabled") === "true",
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      stable,
      ambiguousWith: count > 1 ? [`${count} elements share role+name`] : undefined,
      region: regionOf(f.el),
      href: f.role === "link" ? hrefOf(f.el) : undefined,
      opens: opensOf(f.el),
      state: stateOf(f.el, f.role),
      lead:
        f.nameFrom === "text" || f.nameFrom === "label" ? leadOf(f.el, f.name)
        : f.nameFrom === "aria-labelledby" ? leadOf(document.getElementById((f.el.getAttribute("aria-labelledby") || "").split(/\s+/)[0]) ?? f.el, f.name)
        : undefined,
      icon: f.name.length <= 2 || f.nameFrom === "title" || f.nameFrom === "aria-label" ? iconOf(f.el) : undefined,
      ...where,
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
