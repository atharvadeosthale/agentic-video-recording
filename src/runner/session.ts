import type { Locator, Page } from "playwright";
import type { CameraTarget, Easing, Point, Rect, RecordedEvent, ScenarioConfig } from "../types.js";
import { clamp, curvedPath, mulberry32, resolveEasing, sleep } from "../motion.js";
import { resolveCursorSpeed } from "../config.js";

/** Anything that can be pointed at: a selector, a Playwright locator, a point, or a rectangle. */
export type Target = string | Locator | Point | Rect | { x: number | string; y: number | string };

export interface MoveOptions {
  /** Travel duration in ms. Derived from distance when omitted. */
  duration?: number;
  easing?: Easing;
  /** Offset from the element centre, in CSS px or fractions (-0.5..0.5) of the element size. */
  offset?: Point;
}

export interface ClickOptions extends MoveOptions {
  button?: "left" | "right" | "middle";
  /** How long the button stays down, in ms. */
  hold?: number;
  clickCount?: number;
  /** Pause after the click, ms. Default 150. */
  settle?: number;
}

export interface TypeOptions {
  /** Words per minute. */
  wpm?: number;
  /** 0..1 jitter of the per-key delay. */
  jitter?: number;
  /** Probability 0..1 of a typo that is immediately corrected. Default 0. */
  mistakes?: number;
  /** Type instantly with no animation. */
  instant?: boolean;
  /** Click the target before typing. Default true when a target is given. */
  click?: boolean;
  /** Pause after typing, ms. Default 200. */
  settle?: number;
}

export interface ScrollOptions {
  dx?: number;
  dy?: number;
  duration?: number;
  easing?: Easing;
  /** Where to place the element when scrolling to a target. Default "center". */
  block?: "start" | "center" | "end";
  /** Margin from the block edge, CSS px. Default 40. */
  margin?: number;
}

export interface ZoomOptions {
  /** Absolute camera scale. When omitted and the target is an element or rect, the scale is computed to fit. */
  scale?: number;
  duration?: number;
  easing?: Easing;
  /** Margin fraction around the fitted target. */
  margin?: number;
  /** Keep the cursor in frame by panning while zoomed. */
  follow?: boolean;
  /** Wait for the zoom animation to complete before continuing. Default true. */
  wait?: boolean;
}

export interface SessionHooks {
  /** Called after each user-visible action. Used by dry runs to capture screenshots. */
  onStep?: (name: string, detail?: string) => Promise<void>;
}

export interface SessionMode {
  /** Dry runs skip animation and timing. */
  dry: boolean;
}

/**
 * The scripting surface handed to scenarios. Every method both drives the real browser
 * and appends to the event log that the compositor later uses for cursor and camera.
 */
export class Session {
  readonly events: RecordedEvent[] = [];
  private cursor: Point;
  private pressed = false;
  private recordingState: "idle" | "recording" | "paused" | "stopped" = "idle";
  private rng: () => number;
  private manualZoomActive = false;

  constructor(
    readonly page: Page,
    readonly config: ScenarioConfig,
    private clock: () => number,
    private mode: SessionMode = { dry: false },
    private hooks: SessionHooks = {},
    private onRecordingChange: (state: "start" | "pause" | "resume" | "stop") => Promise<void> = async () => {},
  ) {
    this.cursor = { x: config.viewport.width / 2, y: config.viewport.height / 2 };
    this.rng = mulberry32(1337);
  }

  get viewport() {
    return this.config.viewport;
  }

  /** Current cursor position in CSS px. */
  get cursorPosition(): Point {
    return { ...this.cursor };
  }

  private log(ev: RecordedEvent) {
    this.events.push(ev);
  }

  private now() {
    return this.clock();
  }

  private async step(name: string, detail?: string) {
    this.log({ type: "step", t: this.now(), name, detail });
    await this.hooks.onStep?.(name, detail);
  }

  // ----------------------------------------------------------------------
  // Recording control
  // ----------------------------------------------------------------------

  /** Begin the recorded portion. Everything before this is setup and not included in the video. */
  async startRecording() {
    if (this.recordingState === "recording") return;
    this.recordingState = "recording";
    await this.onRecordingChange("start");
    this.log({ type: "recording", t: this.now(), state: "start" });
    this.log({ type: "mouse", t: this.now(), x: this.cursor.x, y: this.cursor.y });
  }

  async pauseRecording() {
    if (this.recordingState !== "recording") return;
    this.recordingState = "paused";
    this.log({ type: "recording", t: this.now(), state: "pause" });
    await this.onRecordingChange("pause");
  }

  async resumeRecording() {
    if (this.recordingState !== "paused") return;
    this.recordingState = "recording";
    await this.onRecordingChange("resume");
    this.log({ type: "recording", t: this.now(), state: "resume" });
    this.log({ type: "mouse", t: this.now(), x: this.cursor.x, y: this.cursor.y });
  }

  async stopRecording() {
    if (this.recordingState === "stopped" || this.recordingState === "idle") return;
    this.recordingState = "stopped";
    this.log({ type: "recording", t: this.now(), state: "stop" });
    await this.onRecordingChange("stop");
  }

  get isRecording() {
    return this.recordingState === "recording";
  }

  // ----------------------------------------------------------------------
  // Navigation and waiting
  // ----------------------------------------------------------------------

  async goto(url: string, opts: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" } = {}) {
    const t = this.now();
    await this.page.goto(url, { waitUntil: opts.waitUntil ?? "load" });
    this.log({ type: "idle", t, end: this.now(), reason: `goto ${url}` });
    await this.step("goto", url);
  }

  /** Wait for an element to reach a state. Time spent here is trimmed in post when idleTrim is on. */
  async waitFor(target: string | Locator, opts: { state?: "visible" | "attached" | "hidden" | "detached"; timeout?: number } = {}) {
    const t = this.now();
    await this.locator(target).waitFor({ state: opts.state ?? "visible", timeout: opts.timeout });
    this.log({ type: "idle", t, end: this.now(), reason: `waitFor ${describe(target)}` });
  }

  /** Wait for a URL (string, glob or regex). */
  async waitForURL(url: string | RegExp, opts: { timeout?: number } = {}) {
    const t = this.now();
    await this.page.waitForURL(url, opts);
    this.log({ type: "idle", t, end: this.now(), reason: `waitForURL ${url}` });
  }

  /** Wait for the network to go quiet. */
  async waitForNetworkIdle(opts: { timeout?: number } = {}) {
    const t = this.now();
    await this.page.waitForLoadState("networkidle", opts);
    this.log({ type: "idle", t, end: this.now(), reason: "networkidle" });
  }

  /** Intentional pause that stays in the video. */
  async wait(ms: number) {
    if (this.mode.dry) return;
    await sleep(ms);
  }

  /** Run an arbitrary function against the page; treated as idle setup time. */
  async run<T>(fn: (page: Page) => Promise<T>, label = "run"): Promise<T> {
    const t = this.now();
    const out = await fn(this.page);
    this.log({ type: "idle", t, end: this.now(), reason: label });
    return out;
  }

  // ----------------------------------------------------------------------
  // Pointer
  // ----------------------------------------------------------------------

  locator(target: string | Locator): Locator {
    return typeof target === "string" ? this.page.locator(target).first() : target;
  }

  /** Resolve a target to a CSS px rectangle, scrolling it into view smoothly when needed. */
  async resolveRect(target: Target, opts: { scrollIntoView?: boolean } = {}): Promise<Rect> {
    if (typeof target === "string" || isLocator(target)) {
      const loc = this.locator(target);
      await loc.waitFor({ state: "visible" });
      let box = await loc.boundingBox();
      if (!box) throw new Error(`Target not visible: ${describe(target)}`);
      const vp = this.config.viewport;
      const outside = box.y < 0 || box.y + box.height > vp.height || box.x < 0 || box.x + box.width > vp.width;
      if (outside && opts.scrollIntoView !== false) {
        await this.scrollTo(loc);
        box = (await loc.boundingBox()) ?? box;
      }
      return box;
    }
    if ("width" in target && "height" in target) return target as Rect;
    const vp = this.config.viewport;
    const p = { x: resolveCoord(target.x, vp.width), y: resolveCoord(target.y, vp.height) };
    return { x: p.x, y: p.y, width: 0, height: 0 };
  }

  private async resolvePoint(target: Target, offset?: Point): Promise<Point> {
    const r = await this.resolveRect(target);
    let ox = offset?.x ?? 0, oy = offset?.y ?? 0;
    if (Math.abs(ox) <= 0.5 && Math.abs(oy) <= 0.5 && (ox !== 0 || oy !== 0)) {
      ox *= r.width;
      oy *= r.height;
    }
    return { x: r.x + r.width / 2 + ox, y: r.y + r.height / 2 + oy };
  }

  /** Move the cursor to a target with a human-looking eased path. */
  async move(target: Target, opts: MoveOptions = {}) {
    const to = await this.resolvePoint(target, opts.offset);
    await this.moveToPoint(to, opts);
    await this.step("move", describe(target));
  }

  /** Alias of move; hover states show in the recording because the real pointer moves. */
  hover(target: Target, opts: MoveOptions = {}) {
    return this.move(target, opts);
  }

  private async moveToPoint(to: Point, opts: MoveOptions = {}) {
    const from = { ...this.cursor };
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 0.5) return;
    const m = this.config.motion;
    if (this.mode.dry) {
      await this.page.mouse.move(to.x, to.y);
      this.cursor = to;
      this.log({ type: "mouse", t: this.now(), x: to.x, y: to.y });
      return;
    }
    const duration = opts.duration ?? clamp(dist / resolveCursorSpeed(m.cursorSpeed), m.minMoveDuration, m.maxMoveDuration);
    const ease = resolveEasing(opts.easing ?? m.easing);
    const path = curvedPath(from, to);
    const start = this.now();
    const interval = 1000 / 120;
    let elapsed = 0;
    while (elapsed < duration) {
      const p = path(ease(elapsed / duration));
      await this.page.mouse.move(p.x, p.y);
      this.cursor = p;
      this.log({ type: "mouse", t: this.now(), x: p.x, y: p.y });
      await sleep(interval);
      elapsed = this.now() - start;
    }
    await this.page.mouse.move(to.x, to.y);
    this.cursor = to;
    this.log({ type: "mouse", t: this.now(), x: to.x, y: to.y });
  }

  async click(target: Target, opts: ClickOptions = {}) {
    await this.moveToPointFor(target, opts);
    const button = opts.button ?? "left";
    const count = opts.clickCount ?? 1;
    for (let i = 0; i < count; i++) {
      await this.page.mouse.down({ button });
      this.pressed = true;
      this.log({ type: "mousedown", t: this.now(), x: this.cursor.x, y: this.cursor.y, button });
      if (!this.mode.dry) await sleep(opts.hold ?? this.config.motion.clickHold);
      await this.page.mouse.up({ button });
      this.pressed = false;
      this.log({ type: "mouseup", t: this.now(), x: this.cursor.x, y: this.cursor.y, button });
      if (count > 1 && i < count - 1 && !this.mode.dry) await sleep(80);
    }
    if (!this.mode.dry) await sleep(opts.settle ?? 150);
    await this.step("click", describe(target));
  }

  dblclick(target: Target, opts: ClickOptions = {}) {
    return this.click(target, { ...opts, clickCount: 2 });
  }

  private async moveToPointFor(target: Target, opts: MoveOptions) {
    const to = await this.resolvePoint(target, opts.offset);
    await this.moveToPoint(to, opts);
  }

  /** Press and hold the mouse, drag to a target, release. */
  async drag(from: Target, to: Target, opts: MoveOptions = {}) {
    await this.moveToPointFor(from, opts);
    await this.page.mouse.down();
    this.pressed = true;
    this.log({ type: "mousedown", t: this.now(), x: this.cursor.x, y: this.cursor.y, button: "left" });
    if (!this.mode.dry) await sleep(120);
    await this.moveToPointFor(to, opts);
    await this.page.mouse.up();
    this.pressed = false;
    this.log({ type: "mouseup", t: this.now(), x: this.cursor.x, y: this.cursor.y, button: "left" });
    await this.step("drag", `${describe(from)} -> ${describe(to)}`);
  }

  // ----------------------------------------------------------------------
  // Keyboard
  // ----------------------------------------------------------------------

  /**
   * Type text with a natural cadence. Pass `null` as the target to type into whatever is focused.
   */
  async type(target: Target | null, text: string, opts: TypeOptions = {}) {
    if (target && opts.click !== false) await this.click(target, { settle: 80 });
    const m = this.config.motion;
    const wpm = opts.wpm ?? m.wpm;
    const jitter = opts.jitter ?? m.typingJitter;
    const base = 60000 / (wpm * 5);
    const at = { x: this.cursor.x, y: this.cursor.y };
    if (opts.instant || this.mode.dry) {
      await this.page.keyboard.insertText(text);
      this.log({ type: "key", t: this.now(), key: "insertText", ...at });
    } else {
      const chars = Array.from(text);
      for (const ch of chars) {
        if (opts.mistakes && this.rng() < opts.mistakes && /[a-z]/i.test(ch)) {
          const wrong = neighbour(ch, this.rng);
          await this.page.keyboard.type(wrong);
          this.log({ type: "key", t: this.now(), key: wrong, ...at });
          await sleep(base * (1 + this.rng()) + 120);
          await this.page.keyboard.press("Backspace");
          this.log({ type: "key", t: this.now(), key: "Backspace", ...at });
          await sleep(base * 0.8);
        }
        if (ch === "\n") await this.page.keyboard.press("Enter");
        else await this.page.keyboard.type(ch);
        this.log({ type: "key", t: this.now(), key: ch, ...at });
        let delay = base * (1 + (this.rng() * 2 - 1) * jitter);
        if (ch === " " || ch === "." || ch === ",") delay *= 1.6;
        await sleep(delay);
      }
    }
    if (!this.mode.dry) await sleep(opts.settle ?? 200);
    await this.step("type", text.length > 40 ? text.slice(0, 40) + "…" : text);
  }

  /** Press a key or chord, e.g. "Enter", "Control+K". */
  async press(key: string, opts: { settle?: number } = {}) {
    await this.page.keyboard.press(key);
    this.log({ type: "key", t: this.now(), key, x: this.cursor.x, y: this.cursor.y });
    if (!this.mode.dry) await sleep(opts.settle ?? 150);
    await this.step("press", key);
  }

  // ----------------------------------------------------------------------
  // Scrolling
  // ----------------------------------------------------------------------

  /**
   * Scroll by a delta with an eased animation. Scrolls the document by default, or the
   * container given in `within`. Programmatic, so it does not depend on where the pointer is.
   */
  async scroll(opts: ScrollOptions & { within?: string | Locator } = {}) {
    const dx = opts.dx ?? 0, dy = opts.dy ?? 0;
    if (dx === 0 && dy === 0) return;
    const duration = this.mode.dry ? 0 : (opts.duration ?? this.config.motion.scrollDuration);
    const table = easingTable(resolveEasing(opts.easing ?? "smooth"));
    const t0 = this.now();
    const handle = opts.within ? await this.locator(opts.within).elementHandle() : null;
    await this.page.evaluate(animateScroll, { el: handle, dx, dy, duration, table });
    this.log({ type: "scroll", t: t0, dx, dy });
    if (!this.mode.dry) await sleep(100);
    await this.step("scroll", `${dx},${dy}`);
  }

  /** Smoothly scroll the element's scroll container until the element sits at the given block position. */
  async scrollTo(target: string | Locator, opts: ScrollOptions = {}) {
    const loc = this.locator(target);
    await loc.waitFor({ state: "attached" });
    const duration = this.mode.dry ? 0 : (opts.duration ?? this.config.motion.scrollDuration);
    const table = easingTable(resolveEasing(opts.easing ?? "smooth"));
    const t0 = this.now();
    const dy = await loc.evaluate(scrollElementIntoView, { block: opts.block ?? "center", margin: opts.margin ?? 40, duration, table });
    this.log({ type: "scroll", t: t0, dx: 0, dy });
    if (!this.mode.dry) await sleep(100);
    await this.step("scrollTo", describe(target));
  }

  // ----------------------------------------------------------------------
  // Camera
  // ----------------------------------------------------------------------

  /** Zoom the camera onto a target. Purely a post-processing instruction; the page is untouched. */
  async zoom(target: Target, opts: ZoomOptions = {}) {
    const z = this.config.zoom;
    const rect = await this.resolveRect(target);
    const vp = this.config.viewport;
    const margin = opts.margin ?? z.margin;
    let scale = opts.scale;
    if (scale === undefined) {
      if (rect.width > 0 && rect.height > 0) {
        const fitW = vp.width / (rect.width * (1 + 2 * margin));
        const fitH = vp.height / (rect.height * (1 + 2 * margin));
        scale = Math.min(fitW, fitH);
      } else {
        scale = z.autoScale;
      }
    }
    scale = clamp(scale, 1, z.maxScale);
    const cam: CameraTarget = { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2, scale };
    const duration = opts.duration ?? z.duration;
    this.manualZoomActive = true;
    this.log({ type: "zoom", t: this.now(), target: cam, duration, easing: opts.easing ?? z.easing, follow: opts.follow ?? z.followCursor, source: "manual" });
    if (opts.wait !== false && !this.mode.dry) await sleep(duration);
    await this.step("zoom", `${describe(target)} x${scale.toFixed(2)}`);
  }

  /** Return the camera to the full frame. */
  async zoomOut(opts: { duration?: number; easing?: Easing; wait?: boolean } = {}) {
    const duration = opts.duration ?? this.config.zoom.duration;
    this.manualZoomActive = false;
    this.log({ type: "zoomOut", t: this.now(), duration, easing: opts.easing ?? this.config.zoom.easing, source: "manual" });
    if (opts.wait !== false && !this.mode.dry) await sleep(duration);
    await this.step("zoomOut");
  }

  /** Turn automatic click zooming on or off from this point in the timeline. */
  autoZoom(on: boolean) {
    this.log({ type: on ? "autoZoomOn" : "autoZoomOff", t: this.now() });
  }

  /** Add a named marker; shows up in dry-run sheets and the event log. */
  async mark(name: string) {
    await this.step("mark", name);
  }
}

function isLocator(v: unknown): v is Locator {
  return typeof v === "object" && v !== null && "boundingBox" in v && typeof (v as Locator).boundingBox === "function";
}

function resolveCoord(v: number | string, size: number): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (s.endsWith("%")) return (parseFloat(s) / 100) * size;
  return parseFloat(s);
}

export function describe(t: Target | null): string {
  if (t === null) return "focused";
  if (typeof t === "string") return t;
  if (isLocator(t)) return t.toString();
  if ("width" in t) return `rect(${t.x},${t.y},${t.width}x${t.height})`;
  return `point(${t.x},${t.y})`;
}

/** Sample an easing into 64 points so it can be shipped into the page. */
function easingTable(ease: (t: number) => number): number[] {
  return Array.from({ length: 65 }, (_, i) => ease(i / 64));
}

// Runs inside the page. Animates scrollTop/Left of a container with an eased curve.
const animateScroll = ({ el, dx, dy, duration, table }: { el: Element | null; dx: number; dy: number; duration: number; table: number[] }) =>
  new Promise<void>((resolve) => {
    const target: any = el ?? document.scrollingElement ?? document.documentElement;
    const x0 = target.scrollLeft, y0 = target.scrollTop;
    const ease = (t: number) => {
      const i = Math.min(63, Math.floor(t * 64));
      const f = t * 64 - i;
      return table[i] + (table[i + 1] - table[i]) * f;
    };
    if (duration <= 0) {
      target.scrollTo({ left: x0 + dx, top: y0 + dy, behavior: "instant" });
      return resolve();
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      target.scrollTo({ left: x0 + dx * e, top: y0 + dy * e, behavior: "instant" });
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

// Runs inside the page. Finds the element's scroll container and eases it so the element lands at `block`.
const scrollElementIntoView = (el: Element, { block, margin, duration, table }: { block: "start" | "center" | "end"; margin: number; duration: number; table: number[] }) =>
  new Promise<number>((resolve) => {
    let container: any = el.parentElement;
    while (container && container !== document.body) {
      const cs = getComputedStyle(container);
      if (/(auto|scroll)/.test(cs.overflowY) && container.scrollHeight > container.clientHeight + 1) break;
      container = container.parentElement;
    }
    const isDoc = !container || container === document.body;
    const scroller: any = isDoc ? document.scrollingElement ?? document.documentElement : container;
    const r = el.getBoundingClientRect();
    const cr = isDoc ? { top: 0, height: window.innerHeight } : container.getBoundingClientRect();
    let desiredTop: number;
    if (block === "start") desiredTop = cr.top + margin;
    else if (block === "end") desiredTop = cr.top + cr.height - r.height - margin;
    else desiredTop = cr.top + (cr.height - r.height) / 2;
    const maxTop = scroller.scrollHeight - scroller.clientHeight;
    const y0 = scroller.scrollTop;
    const dy = Math.round(Math.max(-y0, Math.min(maxTop - y0, r.top - desiredTop)));
    const ease = (t: number) => {
      const i = Math.min(63, Math.floor(t * 64));
      const f = t * 64 - i;
      return table[i] + (table[i + 1] - table[i]) * f;
    };
    if (duration <= 0 || dy === 0) {
      scroller.scrollTo({ top: y0 + dy, behavior: "instant" });
      return resolve(dy);
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      scroller.scrollTo({ top: y0 + dy * ease(t), behavior: "instant" });
      if (t < 1) requestAnimationFrame(tick);
      else resolve(dy);
    };
    requestAnimationFrame(tick);
  });

const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function neighbour(ch: string, rng: () => number): string {
  const lower = ch.toLowerCase();
  for (const row of rows) {
    const i = row.indexOf(lower);
    if (i >= 0) {
      const opts = [row[i - 1], row[i + 1]].filter(Boolean) as string[];
      const pick = opts[Math.floor(rng() * opts.length)];
      return ch === lower ? pick : pick.toUpperCase();
    }
  }
  return ch;
}
