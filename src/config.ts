import type { ScenarioConfig, UserScenarioConfig } from "./types.js";

export const defaultConfig: ScenarioConfig = {
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
  output: { width: 1920, height: 1080, fps: 60, format: "mp4", crf: 18, lossless: false },
  frame: {
    padding: 96,
    background: "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 50%, #be185d 100%)",
    borderRadius: 16,
    shadow: { blur: 60, offsetY: 24, color: "rgba(0,0,0,0.45)" },
  },
  cursor: {
    enabled: true,
    size: "default",
    style: "arrow",
    clickRipple: true,
    clickScale: true,
    color: "#ffffff",
  },
  zoom: {
    auto: true,
    autoScale: 1.6,
    autoHold: 1500,
    autoLead: 600,
    duration: 700,
    easing: "smooth",
    maxScale: 3,
    margin: 0.12,
    followCursor: true,
  },
  motion: {
    cursorSpeed: "normal",
    minMoveDuration: 350,
    maxMoveDuration: 1600,
    easing: "smooth",
    clickHold: 90,
    wpm: 220,
    typingJitter: 0.35,
    scrollDuration: 600,
  },
  idleTrim: { enabled: true, threshold: 1500, keep: 600, protectCamera: true },
  browser: { headless: true, timeout: 15000, sameTabLinks: true },
  capture: { format: "jpeg", quality: 92 },
  keys: { mode: "shortcuts", hold: 1200, gap: 900, platform: "mac", position: "bottom", offset: 0.1, fontSize: 34 },
  dryRun: { scale: 0.5, contactSheet: true, columns: 3 },
  explore: { index: ".takeone/inventory.json", max: 250, scroll: true },
};

export const cursorSizePresets = { small: 24, default: 36, large: 48, xl: 64 } as const;
export const cursorSpeedPresets = { slow: 0.6, normal: 0.9, fast: 1.6 } as const;

/** Cursor height in output pixels for a given output height. */
export function resolveCursorSize(size: ScenarioConfig["cursor"]["size"], outputHeight: number): number {
  const base = typeof size === "number" ? size : cursorSizePresets[size] ?? cursorSizePresets.default;
  return base * (outputHeight / 1080);
}

export function resolveCursorSpeed(speed: ScenarioConfig["motion"]["cursorSpeed"]): number {
  return typeof speed === "number" ? speed : cursorSpeedPresets[speed] ?? cursorSpeedPresets.normal;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export function resolveConfig(...patches: (UserScenarioConfig | undefined)[]): ScenarioConfig {
  return patches.reduce<ScenarioConfig>((acc, p) => deepMerge(acc, p), defaultConfig);
}
