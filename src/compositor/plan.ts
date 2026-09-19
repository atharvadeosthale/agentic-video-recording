import type { CameraTarget, Easing, Point, RecordedEvent, RecordingManifest, ScenarioConfig, WaitEdit } from "../types.js";
import { clamp, lerp, resolveEasing } from "../motion.js";
import { recordingSegments } from "../runner/index.js";

/**
 * A stretch of source time that is kept in the output. `rate` is how fast source time
 * advances relative to output time: 1 is real time, 8 means the stretch plays 8x faster
 * (time-lapse), so it occupies `(srcEnd - srcStart) / rate` of output time.
 */
export interface KeptRange {
  srcStart: number;
  srcEnd: number;
  outStart: number;
  rate: number;
}

/**
 * Source-time windows a cut must not touch: the full span of every camera animation,
 * plus a small settling margin on each side. Cutting inside one of these would jump the
 * camera mid-move and read as a broken zoom.
 */
export function cameraBusyWindows(keys: CameraKeyframe[], margin = 120): [number, number][] {
  return keys
    .map((k) => [k.t - margin, k.t + k.duration + margin] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** True when [a, b] overlaps any protected window. */
function overlapsAny(a: number, b: number, windows: [number, number][]): boolean {
  for (const [w0, w1] of windows) {
    if (w1 <= a) continue;
    if (w0 >= b) break;
    return true;
  }
  return false;
}

/**
 * Piece of source time with the rate it plays at: `rate` 1 is real time, higher is faster.
 * A `rate` of Infinity is dropped entirely.
 */
interface Piece {
  srcStart: number;
  srcEnd: number;
  rate: number;
}

/** Source time an idle stretch keeps, and how fast it plays, given its edit mode. */
function editIdle(ev: { t: number; end: number; edit?: WaitEdit }, cfg: ScenarioConfig, protect: [number, number][]): Piece[] {
  // Waiting is the default: a wait is shown in real time unless it asks otherwise.
  const mode: WaitEdit = ev.edit ?? "keep";
  const len = ev.end - ev.t;

  if (mode === "keep") return [{ srcStart: ev.t, srcEnd: ev.end, rate: 1 }];
  if (typeof mode === "number" && mode > 1) {
    // Time-lapse: the whole wait is shown, compressed. It also makes any camera move
    // inside the wait play at the same rate, so the zoom stays smooth rather than jumpy.
    return [{ srcStart: ev.t, srcEnd: ev.end, rate: mode }];
  }

  // Trim: keep the opening, and keep any camera work that happens during the wait, but
  // drop what lies between them. A zoom inside a long wait therefore still plays in full,
  // with the dead time on either side of it removed.
  if (!cfg.idleTrim.enabled) return [{ srcStart: ev.t, srcEnd: ev.end, rate: 1 }];
  if (len <= cfg.idleTrim.threshold) return [{ srcStart: ev.t, srcEnd: ev.end, rate: 1 }];

  // Spans that must survive: the opening build-up, plus every camera move in the wait.
  const keepSpans: [number, number][] = [];
  if (cfg.idleTrim.keep > 0) keepSpans.push([ev.t, Math.min(ev.t + cfg.idleTrim.keep, ev.end)]);
  for (const [w0, w1] of protect) {
    const a = Math.max(w0, ev.t);
    const b = Math.min(w1, ev.end);
    if (b > a) keepSpans.push([a, b]);
  }
  keepSpans.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const span of keepSpans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }

  // Cover the whole wait explicitly so the caller never keeps an implicit gap.
  const pieces: Piece[] = [];
  let cursor = ev.t;
  for (const [a, b] of merged) {
    if (a > cursor) pieces.push({ srcStart: cursor, srcEnd: a, rate: Infinity });
    pieces.push({ srcStart: a, srcEnd: b, rate: 1 });
    cursor = b;
  }
  if (cursor < ev.end) pieces.push({ srcStart: cursor, srcEnd: ev.end, rate: Infinity });
  return pieces;
}

/**
 * Build the mapping from output time to source time.
 *
 * Recording segments are split by every wait's edit mode. Cuts never begin inside a camera
 * animation: when a wait and a zoom overlap, the wait plays through the zoom whole and only
 * the remainder is trimmed. Time-lapse waits replay at their own rate instead of jumping.
 */
export function buildTimeline(
  manifest: RecordingManifest,
  cfg: ScenarioConfig,
  busy: [number, number][] = [],
): { ranges: KeptRange[]; outDuration: number } {
  const segments = recordingSegments(manifest.events, manifest.duration);
  const protect = cfg.idleTrim.protectCamera ? busy : [];

  // Every wait becomes explicit pieces covering exactly its own span.
  const edits = manifest.events
    .filter((ev): ev is Extract<RecordedEvent, { type: "idle" }> => ev.type === "idle")
    .flatMap((ev) => editIdle(ev, cfg, protect))
    .filter((p) => p.srcEnd > p.srcStart)
    .sort((a, b) => a.srcStart - b.srcStart);

  const ranges: KeptRange[] = [];
  let out = 0;
  let ei = 0;
  for (const [segStart, segEnd] of segments) {
    let cursor = segStart;
    while (cursor < segEnd) {
      // Skip edits that end before the cursor or start after the segment.
      while (ei < edits.length && edits[ei].srcEnd <= cursor) ei++;
      const next = ei < edits.length && edits[ei].srcStart < segEnd ? edits[ei] : null;

      if (!next) {
        const end = segEnd;
        ranges.push({ srcStart: cursor, srcEnd: end, outStart: out, rate: 1 });
        out += end - cursor;
        cursor = end;
        break;
      }

      // Real time up to the start of this edit.
      if (next.srcStart > cursor) {
        ranges.push({ srcStart: cursor, srcEnd: next.srcStart, outStart: out, rate: 1 });
        out += next.srcStart - cursor;
        cursor = next.srcStart;
      }

      const from = Math.max(cursor, next.srcStart);
      const to = Math.min(next.srcEnd, segEnd);
      if (Number.isFinite(next.rate)) {
        ranges.push({ srcStart: from, srcEnd: to, outStart: out, rate: next.rate });
        out += (to - from) / next.rate;
      }
      // Infinite rate (a trimmed tail) contributes no output and is simply skipped.
      cursor = to;
      ei++;
    }
  }
  return { ranges, outDuration: out };
}

export function outToSource(ranges: KeptRange[], tOut: number): number {
  let lo = 0, hi = ranges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid].outStart <= tOut) lo = mid; else hi = mid - 1;
  }
  const r = ranges[lo];
  // Advance source time at the range's own rate, clamped to the end of the range.
  return Math.min(r.srcEnd, r.srcStart + (tOut - r.outStart) * r.rate);
}

/**
 * Did source time actually get dropped between two source times?
 *
 * Two adjacent ranges are not a cut: when range A ends exactly where range B starts, source
 * time flows continuously across the boundary and the output is identical to one range. Only
 * a genuine gap means a jump, so this compares source continuity rather than range indices.
 */
export function crossesCut(ranges: KeptRange[], srcA: number, srcB: number): boolean {
  if (srcB <= srcA) return false;
  // Ranges overlapping the span, in output order.
  const covering = ranges.filter((r) => r.srcEnd > srcA && r.srcStart < srcB);
  for (let i = 1; i < covering.length; i++) {
    // A gap in source time between consecutive kept ranges is a real cut.
    if (covering[i].srcStart > covering[i - 1].srcEnd + 0.5) return true;
  }
  // A rate change is also a discontinuity in how source time advances.
  return covering.some((r) => r.rate !== 1);
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface CameraKeyframe {
  t: number;
  target: CameraTarget;
  duration: number;
  easing: Easing;
  follow: boolean;
}

const FULL = (vw: number, vh: number): CameraTarget => ({ cx: vw / 2, cy: vh / 2, scale: 1 });

/**
 * Turn zoom events plus (optionally) click and typing events into a camera keyframe list.
 * Auto zooms start slightly before the interaction, which is only possible because we
 * do this in post.
 */
export function planCamera(manifest: RecordingManifest, cfg: ScenarioConfig): CameraKeyframe[] {
  const { width: vw, height: vh } = manifest.viewport;
  const z = cfg.zoom;
  const keys: CameraKeyframe[] = [];
  const events = [...manifest.events].sort((a, b) => a.t - b.t);

  let autoOn = z.auto;
  let manualActive = false;
  let segmentStart = 0;
  // Current auto zoom, if any
  let autoActive: { target: CameraTarget; lastInteraction: number } | null = null;
  const LEAD = z.autoLead;

  const closeAuto = () => {
    if (!autoActive) return;
    keys.push({ t: autoActive.lastInteraction + z.autoHold, target: FULL(vw, vh), duration: z.duration, easing: z.easing, follow: false });
    autoActive = null;
  };

  for (const ev of events) {
    if (ev.type === "autoZoomOn") { autoOn = true; continue; }
    if (ev.type === "autoZoomOff") { autoOn = false; closeAuto(); continue; }
    if (ev.type === "zoom") {
      if (autoActive) {
        // If the auto hold already expired, ease out first; otherwise the manual zoom takes over directly.
        if (ev.t > autoActive.lastInteraction + z.autoHold) closeAuto();
        else autoActive = null;
      }
      manualActive = true;
      keys.push({ t: ev.t, target: ev.target, duration: ev.duration, easing: ev.easing, follow: ev.follow ?? z.followCursor });
      continue;
    }
    if (ev.type === "zoomOut") {
      manualActive = false;
      keys.push({ t: ev.t, target: FULL(vw, vh), duration: ev.duration, easing: ev.easing, follow: false });
      continue;
    }
    if (ev.type === "recording") {
      if (ev.state === "start" || ev.state === "resume") {
        segmentStart = ev.t;
        // Interactions from setup must not leave the camera zoomed at the first frame.
        if (autoActive) { keys.push({ t: ev.t - 1, target: FULL(vw, vh), duration: 1, easing: "linear", follow: false }); autoActive = null; }
      } else if (autoActive) {
        // Don't let an auto zoom straddle a cut; ease out normally if the hold already expired.
        if (ev.t > autoActive.lastInteraction + z.autoHold) closeAuto();
        else { keys.push({ t: ev.t, target: FULL(vw, vh), duration: 1, easing: "linear", follow: false }); autoActive = null; }
      }
      continue;
    }
    const isInteraction = ev.type === "mousedown" || (ev.type === "key" && ev.x !== undefined && ev.key !== "insertText");
    if (!isInteraction || !autoOn || manualActive) continue;
    const p: Point = { x: ev.x!, y: ev.y! };
    if (autoActive) {
      // Auto-hold expired? then a fresh zoom.
      if (ev.t - autoActive.lastInteraction > z.autoHold) {
        closeAuto();
      } else {
        // Re-centre only if the new point is outside the inner 60% of the current view.
        const view = { w: vw / autoActive.target.scale, h: vh / autoActive.target.scale };
        const dx = Math.abs(p.x - autoActive.target.cx), dy = Math.abs(p.y - autoActive.target.cy);
        if (dx > view.w * 0.3 || dy > view.h * 0.3) {
          autoActive.target = { cx: p.x, cy: p.y, scale: z.autoScale };
          keys.push({ t: ev.t - LEAD / 2, target: autoActive.target, duration: z.duration * 0.8, easing: z.easing, follow: z.followCursor });
        }
        autoActive.lastInteraction = ev.t;
        continue;
      }
    }
    autoActive = { target: { cx: p.x, cy: p.y, scale: z.autoScale }, lastInteraction: ev.t };
    keys.push({ t: Math.max(segmentStart, ev.t - LEAD), target: autoActive.target, duration: z.duration, easing: z.easing, follow: z.followCursor });
  }
  closeAuto();
  keys.sort((a, b) => a.t - b.t);
  return keys;
}

export interface CameraState extends CameraTarget {
  follow: boolean;
}

/** Evaluates camera state at any source time from keyframes, interpolating from wherever the camera was. */
export function makeCameraEvaluator(keys: CameraKeyframe[], vw: number, vh: number) {
  const froms: CameraTarget[] = [];
  const evalAt = (t: number, upto = keys.length): CameraState => {
    let state: CameraState = { ...FULL(vw, vh), follow: false };
    for (let i = 0; i < upto; i++) {
      const k = keys[i];
      if (k.t > t) break;
      const from = froms[i] ?? (froms[i] = evalAt(k.t, i));
      const p = k.duration <= 0 ? 1 : clamp((t - k.t) / k.duration, 0, 1);
      const e = resolveEasing(k.easing)(p);
      // Interpolate in "log scale" so zoom feels linear.
      const scale = Math.exp(lerp(Math.log(from.scale), Math.log(k.target.scale), e));
      state = { cx: lerp(from.cx, k.target.cx, e), cy: lerp(from.cy, k.target.cy, e), scale, follow: k.follow };
    }
    return state;
  };
  return (t: number) => evalAt(t);
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorSample extends Point {
  t: number;
}

export function extractCursor(events: RecordedEvent[]): { samples: CursorSample[]; downs: { t: number; up: number; x: number; y: number }[] } {
  const samples: CursorSample[] = [];
  const downs: { t: number; up: number; x: number; y: number }[] = [];
  for (const ev of events) {
    if (ev.type === "mouse" || ev.type === "mousedown" || ev.type === "mouseup") samples.push({ t: ev.t, x: ev.x, y: ev.y });
    if (ev.type === "mousedown") downs.push({ t: ev.t, up: Infinity, x: ev.x, y: ev.y });
    if (ev.type === "mouseup") {
      const last = [...downs].reverse().find((d) => d.up === Infinity);
      if (last) last.up = ev.t;
    }
  }
  samples.sort((a, b) => a.t - b.t);
  return { samples, downs };
}

export function cursorAt(samples: CursorSample[], t: number): Point {
  if (!samples.length) return { x: 0, y: 0 };
  if (t <= samples[0].t) return samples[0];
  if (t >= samples[samples.length - 1].t) return samples[samples.length - 1];
  let lo = 0, hi = samples.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const span = b.t - a.t;
  // A long gap between samples means the cursor was parked; hold rather than drift.
  if (span > 400) return t - a.t < span / 2 ? a : b;
  const k = span === 0 ? 0 : (t - a.t) / span;
  return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
}

/** Index of the last frame whose timestamp is <= t. */
export function frameIndexAt(frames: { t: number }[], t: number): number {
  if (!frames.length) return -1;
  let lo = 0, hi = frames.length - 1;
  if (t < frames[0].t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Key overlay
// ---------------------------------------------------------------------------

export type KeyToast =
  | { kind: "shortcut"; start: number; end: number; groups: string[][]; }
  | { kind: "text"; start: number; end: number; chars: { t: number; ch: string }[] };

const macGlyphs: Record<string, string> = {
  Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Escape: "esc", Backspace: "⌫", Tab: "⇥",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "␣", Delete: "⌦", " ": "␣",
};
const winGlyphs: Record<string, string> = {
  Meta: "Win", Control: "Ctrl", Alt: "Alt", Shift: "Shift", Enter: "Enter", Escape: "Esc", Backspace: "⌫", Tab: "Tab",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", Delete: "Del", " ": "Space",
};

/** Turn a Playwright key string like "Control+Shift+K" into display labels. */
export function keyLabels(key: string, platform: "mac" | "windows"): string[] {
  const g = platform === "mac" ? macGlyphs : winGlyphs;
  const parts = key.split("+").map((p) => (p === "ControlOrMeta" ? (platform === "mac" ? "Meta" : "Control") : p));
  return parts.map((p) => g[p] ?? (p.length === 1 ? p.toUpperCase() : p.replace(/^Key/, "").replace(/^Digit/, "")));
}

const isSpecial = (key: string) => key.includes("+") || key.length > 1;

export function planKeyToasts(events: RecordedEvent[], cfg: ScenarioConfig): KeyToast[] {
  const k = cfg.keys;
  if (k.mode === "off") return [];
  const toasts: KeyToast[] = [];
  let shortcut: Extract<KeyToast, { kind: "shortcut" }> | null = null;
  let text: Extract<KeyToast, { kind: "text" }> | null = null;
  // A new pill replaces whatever is on screen; end the previous one at that moment.
  const cutPrevious = (t: number) => {
    const last = toasts[toasts.length - 1];
    if (last && last.end > t) last.end = t;
  };
  for (const ev of events) {
    if (ev.type !== "key" || ev.key === "insertText") continue;
    const fromPress = ev.source !== "type";
    let show: boolean;
    if (ev.show !== undefined) show = ev.show;
    else if (k.mode === "manual") show = false;
    else if (k.mode === "all") show = true;
    else show = fromPress && isSpecial(ev.key);
    if (!show) continue;

    const special = isSpecial(ev.key);
    // Backspace typed as part of text edits the pill; Backspace from press() is shown as a key.
    if (special && !(ev.key === "Backspace" && !fromPress)) {
      // Shortcut / special key: append to an active shortcut pill or start one.
      text = null;
      const labels = keyLabels(ev.key, k.platform);
      if (shortcut && ev.t - shortcut.end + k.hold < k.gap && shortcut.groups.length < 4) {
        shortcut.groups.push(labels);
        shortcut.end = ev.t + k.hold;
      } else {
        cutPrevious(ev.t);
        shortcut = { kind: "shortcut", start: ev.t, end: ev.t + k.hold, groups: [labels] };
        toasts.push(shortcut);
      }
      continue;
    }
    // Typed character (or backspace) joins the current text pill.
    shortcut = null;
    if (!text || ev.t - text.end + k.hold > k.gap) {
      cutPrevious(ev.t);
      text = { kind: "text", start: ev.t, end: ev.t + k.hold, chars: [] };
      toasts.push(text);
    }
    text.chars.push({ t: ev.t, ch: ev.key });
    text.end = ev.t + k.hold;
  }
  return toasts;
}

export interface KeyHud {
  kind: "shortcut" | "text";
  alpha: number;
  /** For shortcuts: groups of key labels. For text: a single label. */
  groups: string[][];
}

const FADE_IN = 120, FADE_OUT = 260;

export function keyHudAt(toasts: KeyToast[], t: number): KeyHud | null {
  for (let i = toasts.length - 1; i >= 0; i--) {
    const toast = toasts[i];
    if (t < toast.start || t > toast.end + FADE_OUT) continue;
    const alpha = t < toast.start + FADE_IN ? (t - toast.start) / FADE_IN : t > toast.end ? 1 - (t - toast.end) / FADE_OUT : 1;
    if (toast.kind === "shortcut") return { kind: "shortcut", alpha, groups: toast.groups };
    let s = "";
    for (const c of toast.chars) {
      if (c.t > t) break;
      if (c.ch === "Backspace") s = s.slice(0, -1);
      else s += c.ch;
    }
    if (!s) return null;
    return { kind: "text", alpha, groups: [[s]] };
  }
  return null;
}
