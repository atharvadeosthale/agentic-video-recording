import type { Easing, Point } from "./types.js";

/** Cubic bezier easing solver (same semantics as CSS cubic-bezier). */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-6) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    let lo = 0, hi = 1;
    t = x;
    while (lo < hi) {
      const sx = sampleX(t);
      if (Math.abs(sx - x) < 1e-6) return t;
      if (x > sx) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveX(x)));
}

const presets: Record<string, (t: number) => number> = {
  linear: (t) => t,
  smooth: cubicBezier(0.4, 0, 0.2, 1),
  snappy: cubicBezier(0.2, 0.9, 0.3, 1),
  easeOut: cubicBezier(0, 0, 0.2, 1),
  easeIn: cubicBezier(0.4, 0, 1, 1),
  // slight overshoot then settle
  spring: cubicBezier(0.34, 1.35, 0.64, 1),
};

export function resolveEasing(e: Easing | undefined): (t: number) => number {
  if (!e) return presets.smooth;
  if (Array.isArray(e)) return cubicBezier(e[0], e[1], e[2], e[3]);
  return presets[e] ?? presets.smooth;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * A gently curved path from a to b. Control point is offset perpendicular to the
 * segment so long moves arc slightly instead of tracking a ruler.
 */
export function curvedPath(a: Point, b: Point, curvature = 0.12): (t: number) => Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return () => ({ ...b });
  const sign = (a.x + a.y) % 2 === 0 ? 1 : -1; // deterministic per start point
  const nx = (-dy / dist) * dist * curvature * sign;
  const ny = (dx / dist) * dist * curvature * sign;
  const c = { x: (a.x + b.x) / 2 + nx, y: (a.y + b.y) / 2 + ny };
  return (t) => ({
    x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * c.x + t * t * b.x,
    y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * c.y + t * t * b.y,
  });
}

/** Small deterministic PRNG so jitter is reproducible per scenario. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
