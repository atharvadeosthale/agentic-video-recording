import type { CameraTarget, Easing, Point, RecordedEvent, RecordingManifest, ScenarioConfig } from "../types.js";
import { clamp, lerp, resolveEasing } from "../motion.js";
import { recordingSegments } from "../runner/index.js";

/** A stretch of source time that is kept in the output. */
export interface KeptRange {
  srcStart: number;
  srcEnd: number;
  outStart: number;
}

/**
 * Build the mapping from output time to source time: recording segments minus
 * shortened idle stretches.
 */
export function buildTimeline(manifest: RecordingManifest, cfg: ScenarioConfig): { ranges: KeptRange[]; outDuration: number } {
  const segments = recordingSegments(manifest.events, manifest.duration);
  // Cuts: [from, to] in source time that are dropped.
  const cuts: [number, number][] = [];
  if (cfg.idleTrim.enabled) {
    for (const ev of manifest.events) {
      if (ev.type !== "idle") continue;
      const len = ev.end - ev.t;
      if (len > cfg.idleTrim.threshold) cuts.push([ev.t + cfg.idleTrim.keep, ev.end]);
    }
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const ranges: KeptRange[] = [];
  let out = 0;
  for (const [segStart, segEnd] of segments) {
    let cursor = segStart;
    for (const [c0, c1] of cuts) {
      if (c1 <= cursor || c0 >= segEnd) continue;
      const cutStart = Math.max(c0, cursor);
      if (cutStart > cursor) {
        ranges.push({ srcStart: cursor, srcEnd: cutStart, outStart: out });
        out += cutStart - cursor;
      }
      cursor = Math.max(cursor, Math.min(c1, segEnd));
    }
    if (segEnd > cursor) {
      ranges.push({ srcStart: cursor, srcEnd: segEnd, outStart: out });
      out += segEnd - cursor;
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
  return Math.min(r.srcEnd, r.srcStart + (tOut - r.outStart));
}

/** Is there a cut between two source times (used to avoid smoothing across a jump)? */
export function crossesCut(ranges: KeptRange[], srcA: number, srcB: number): boolean {
  const idx = (t: number) => ranges.findIndex((r) => t >= r.srcStart && t <= r.srcEnd);
  return idx(srcA) !== idx(srcB);
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
