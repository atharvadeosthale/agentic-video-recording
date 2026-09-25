import { mkdirSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import type { RecordingManifest, ScenarioConfig, UserScenarioConfig } from "../types.js";
import { resolveConfig } from "../config.js";
import { launchBrowser } from "../browser.js";
import { FrameCapture } from "./capture.js";
import { Session } from "./session.js";
import type { Scenario } from "../scenario.js";
import { makeContactSheet } from "../contact-sheet.js";

export interface RecordOptions {
  /** Directory to write frames and manifest into. */
  outDir: string;
  /** Config overrides applied on top of the scenario config. */
  config?: UserScenarioConfig;
  log?: (msg: string) => void;
}

export interface RecordResult {
  outDir: string;
  manifestPath: string;
  manifest: RecordingManifest;
}

/**
 * Drive a scenario in a real browser and capture raw frames plus the event log.
 * Nothing here depends on the agent's speed: the scenario's own pacing is the clock.
 */
export async function recordScenario(scenario: Scenario, opts: RecordOptions): Promise<RecordResult> {
  const log = opts.log ?? (() => {});
  const config = resolveConfig(scenario.config, opts.config);
  const outDir = resolve(opts.outDir);
  const framesDir = join(outDir, "frames");
  if (existsSync(framesDir)) rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  log(`Launching Chromium (${config.viewport.width}x${config.viewport.height} @${config.viewport.deviceScaleFactor}x)`);
  const launched = await launchBrowser(config.browser, config.viewport, log);
  const page = await getPage(launched.context);
  const capture = new FrameCapture(page, framesDir, config.capture);

  // The screencast runs for the whole scenario so the recording boundary can be placed anywhere.
  await capture.start();
  const started = Date.now();
  let error: unknown;
  const session = new Session(page, config, () => capture.now(), { dry: false }, {}, async (state) => {
    capture.setWriting(state === "start" || state === "resume");
    log(`Recording ${state}`);
  });
  // Don't write frames until the scenario opts in; if it never does we keep everything.
  capture.setWriting(true);

  try {
    log("Running scenario");
    await scenario.run(session);
    if (session.isRecording) await session.stopRecording();
  } catch (e) {
    error = e;
  }
  const frames = await capture.stop();
  const duration = Date.now() - started;
  await launched.close();

  // Trim frames that fall outside recording segments (pre-roll setup).
  const segments = recordingSegments(session.events, duration);
  const kept = frames.filter((f) => segments.some(([a, b]) => f.t >= a - 100 && f.t <= b + 100));
  for (const f of frames) if (!kept.includes(f)) safeUnlink(join(framesDir, f.file));

  const manifest: RecordingManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    config,
    viewport: config.viewport,
    frameSize: capture.frameSize ?? {
      width: config.viewport.width * config.viewport.deviceScaleFactor,
      height: config.viewport.height * config.viewport.deviceScaleFactor,
    },
    frames: kept,
    events: session.events,
    duration,
  };
  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  log(`Captured ${kept.length} frames over ${(duration / 1000).toFixed(1)}s -> ${manifestPath}`);
  // A failed run keeps what it captured: minutes of footage should never vanish with the error.
  if (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    if (kept.length) e.message += `\n\nThe ${kept.length} frames captured before the failure were kept. \`takeone render ${opts.outDir}\` renders them as a partial video.`;
    throw e;
  }
  return { outDir, manifestPath, manifest };
}

/** Recording segments as [start, end] in ms. Implicit whole-run segment if the scenario never opted in. */
export function recordingSegments(events: RecordingManifest["events"], duration: number): [number, number][] {
  const segs: [number, number][] = [];
  let open: number | null = null;
  let sawAny = false;
  for (const ev of events) {
    if (ev.type !== "recording") continue;
    sawAny = true;
    if ((ev.state === "start" || ev.state === "resume") && open === null) open = ev.t;
    if ((ev.state === "pause" || ev.state === "stop") && open !== null) {
      segs.push([open, ev.t]);
      open = null;
    }
  }
  if (open !== null) segs.push([open, duration]);
  if (!sawAny) return [[0, duration]];
  return segs;
}

async function getPage(context: import("playwright").BrowserContext): Promise<Page> {
  const pages = context.pages();
  return pages[0] ?? (await context.newPage());
}

function safeUnlink(p: string) {
  try {
    unlinkSync(p);
  } catch {}
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

export interface DryRunOptions {
  outDir: string;
  /** Skip pacing (instant typing, no waits). Quicker, but no longer the same run the recording will be. */
  fast?: boolean;
  config?: UserScenarioConfig;
  log?: (msg: string) => void;
}

export interface DryRunResult {
  outDir: string;
  steps: { index: number; name: string; detail?: string; file: string }[];
  contactSheet?: string;
  error?: string;
}

/**
 * Execute the scenario exactly as a recording would (same typing cadence, waits, cursor
 * travel and click holds) but without capturing or rendering, taking a screenshot after
 * every action. Because the page sees the same input at the same pace, a dry run that
 * passes is a recording that will pass. `fast` trades that guarantee for speed.
 */
export async function dryRunScenario(scenario: Scenario, opts: DryRunOptions): Promise<DryRunResult> {
  const log = opts.log ?? (() => {});
  const config = resolveConfig(scenario.config, opts.config);
  const outDir = resolve(opts.outDir);
  const shotsDir = join(outDir, "dry-run");
  if (existsSync(shotsDir)) rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  const scale = config.dryRun.scale;
  // Render at a lower device scale factor so screenshots are cheap.
  const viewport = { ...config.viewport, deviceScaleFactor: Math.max(0.25, config.viewport.deviceScaleFactor * scale) };
  const launched = await launchBrowser(config.browser, viewport, log);
  const page = await getPage(launched.context);
  const steps: DryRunResult["steps"] = [];
  let index = 0;
  const start = Date.now();

  const session = new Session(page, { ...config, viewport }, () => Date.now() - start, { dry: true, fast: opts.fast }, {
    onStep: async (name, detail) => {
      index++;
      const file = `step-${String(index).padStart(3, "0")}.jpg`;
      // A click can kick off a navigation; screenshots fail mid-navigation, so retry briefly.
      for (let attempt = 0; ; attempt++) {
        try {
          await page.screenshot({ path: join(shotsDir, file), type: "jpeg", quality: 80 });
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          await page.waitForLoadState("load", { timeout: 3000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      steps.push({ index, name, detail, file });
      log(`  ${index}. ${name}${detail ? ` ${detail}` : ""}`);
    },
  });

  let error: string | undefined;
  try {
    await scenario.run(session);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    index++;
    const file = `step-${String(index).padStart(3, "0")}-error.jpg`;
    await page.screenshot({ path: join(shotsDir, file), type: "jpeg", quality: 80 }).catch(() => {});
    steps.push({ index, name: "error", detail: error, file });
    log(`  ! ${error}`);
  }
  await launched.close();

  writeFileSync(join(shotsDir, "steps.json"), JSON.stringify({ steps, error, config }, null, 2));
  let contactSheet: string | undefined;
  if (config.dryRun.contactSheet && steps.length) {
    const sheetPath = join(shotsDir, "contact-sheet.jpg");
    contactSheet = sheetPath;
    await makeContactSheet(
      steps.map((s) => ({ file: join(shotsDir, s.file), label: `${s.index}. ${s.name}${s.detail ? " · " + s.detail : ""}` })),
      sheetPath,
      { columns: config.dryRun.columns, cellWidth: Math.round(config.viewport.width * scale), aspect: config.viewport.width / config.viewport.height, browser: config.browser },
    );
    log(`Contact sheet -> ${contactSheet}`);
  }
  return { outDir, steps, contactSheet, error };
}

export { Session } from "./session.js";
export type { ScenarioConfig };
