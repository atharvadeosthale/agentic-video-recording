#!/usr/bin/env node
import { Command } from "commander";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { loadScenario } from "./load-scenario.js";
import { recordScenario, dryRunScenario } from "./runner/index.js";
import { renderRecording } from "./compositor/render.js";
import { chromiumInfo, launchBrowser } from "./browser.js";
import { ffmpegVersion } from "./ffmpeg.js";
import { resolveConfig } from "./config.js";
import type { UserScenarioConfig } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const log = (s: string) => console.error(s);

function parseOverrides(o: { config?: string; width?: string; height?: string; fps?: string; viewport?: string; dpr?: string; chromium?: string; headed?: boolean; state?: string; profile?: string }): UserScenarioConfig {
  const c: UserScenarioConfig = o.config ? JSON.parse(o.config) : {};
  c.output ??= {};
  c.viewport ??= {};
  c.browser ??= {};
  if (o.width) c.output.width = Number(o.width);
  if (o.height) c.output.height = Number(o.height);
  if (o.fps) c.output.fps = Number(o.fps);
  if (o.viewport) {
    const [w, h] = o.viewport.split("x").map(Number);
    c.viewport.width = w;
    c.viewport.height = h;
  }
  if (o.dpr) c.viewport.deviceScaleFactor = Number(o.dpr);
  if (o.chromium) c.browser.executablePath = o.chromium;
  if (o.headed) c.browser.headless = false;
  if (o.state) c.browser.storageState = resolve(o.state);
  if (o.profile) c.browser.userDataDir = resolve(o.profile);
  return c;
}

function defaultOutDir(scenarioFile: string, name?: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return join("recordings", `${name ?? basename(scenarioFile).replace(/\.[^.]+$/, "")}-${stamp}`);
}

const program = new Command();
program.name("avr").description(pkg.description).version(pkg.version);

const sharedOpts = (cmd: Command) =>
  cmd
    .option("-c, --config <json>", "JSON config overrides")
    .option("--viewport <WxH>", "browser viewport, e.g. 1920x1080")
    .option("--dpr <n>", "device scale factor (2 = retina)")
    .option("--width <px>", "output width")
    .option("--height <px>", "output height")
    .option("--fps <n>", "output frame rate")
    .option("--chromium <path>", "Chromium/Chrome executable to use")
    .option("--headed", "show the browser window")
    .option("--state <file>", "Playwright storage state file (cookies, localStorage, IndexedDB)")
    .option("--profile <dir>", "persistent Chromium user data dir");

sharedOpts(
  program
    .command("record")
    .description("Run a scenario, capture it, and (by default) render the final video")
    .argument("<scenario>", "scenario .ts/.js file")
    .option("-o, --out <dir>", "output directory")
    .option("--no-render", "only capture raw frames + manifest; render later with `avr render`")
    .option("--no-contact-sheet", "skip the keyframe sheet"),
).action(async (file: string, o) => {
  const scenario = await loadScenario(file);
  const overrides = parseOverrides(o);
  const outDir = o.out ?? defaultOutDir(file, scenario.config.name);
  const rec = await recordScenario(scenario, { outDir, config: overrides, log });
  if (o.render) {
    const res = await renderRecording({ recordingDir: rec.outDir, config: overrides, contactSheet: o.contactSheet, log, onProgress: progress });
    console.log(JSON.stringify({ outDir: rec.outDir, video: res.outFile, keyframes: res.contactSheet, durationMs: res.durationMs }, null, 2));
  } else {
    console.log(JSON.stringify({ outDir: rec.outDir, manifest: rec.manifestPath, frames: rec.manifest.frames.length }, null, 2));
  }
});

sharedOpts(
  program
    .command("render")
    .description("Render (or re-render) a captured recording with the given look")
    .argument("<recordingDir>", "directory containing manifest.json")
    .option("-o, --out <file>", "output video file")
    .option("--no-contact-sheet", "skip the keyframe sheet"),
).action(async (dir: string, o) => {
  const res = await renderRecording({ recordingDir: dir, outFile: o.out, config: parseOverrides(o), contactSheet: o.contactSheet, log, onProgress: progress });
  console.log(JSON.stringify({ video: res.outFile, keyframes: res.contactSheet, durationMs: res.durationMs }, null, 2));
});

sharedOpts(
  program
    .command("dry-run")
    .description("Run a scenario without animation, screenshotting every step into one contact sheet")
    .argument("<scenario>", "scenario .ts/.js file")
    .option("-o, --out <dir>", "output directory")
    .option("--scale <n>", "screenshot scale factor, e.g. 0.5")
    .option("--columns <n>", "contact sheet columns")
    .option("--no-contact-sheet", "keep individual screenshots only"),
).action(async (file: string, o) => {
  const scenario = await loadScenario(file);
  const overrides = parseOverrides(o);
  overrides.dryRun = { ...(overrides.dryRun ?? {}) };
  if (o.scale) overrides.dryRun.scale = Number(o.scale);
  if (o.columns) overrides.dryRun.columns = Number(o.columns);
  if (o.contactSheet === false) overrides.dryRun.contactSheet = false;
  const outDir = o.out ?? defaultOutDir(file, scenario.config.name);
  const res = await dryRunScenario(scenario, { outDir, config: overrides, log });
  console.log(JSON.stringify({ outDir: res.outDir, contactSheet: res.contactSheet, steps: res.steps.length, error: res.error }, null, 2));
  if (res.error) process.exitCode = 1;
});

program
  .command("login")
  .description("Open a visible browser so you can log in, then save cookies/localStorage/IndexedDB to a state file")
  .requiredOption("--url <url>", "page to open")
  .option("-o, --out <file>", "state file", "state.json")
  .option("--chromium <path>", "Chromium/Chrome executable to use")
  .option("--profile <dir>", "persistent Chromium user data dir to reuse")
  .action(async (o) => {
    const cfg = resolveConfig({ browser: { headless: false, executablePath: o.chromium, userDataDir: o.profile } });
    const launched = await launchBrowser(cfg.browser, { width: 1280, height: 800, deviceScaleFactor: 1 }, log);
    const page = launched.context.pages()[0] ?? (await launched.context.newPage());
    await page.goto(o.url);
    log("Log in in the browser window, then press Enter here to save the state...");
    await new Promise<void>((r) => process.stdin.once("data", () => r()));
    await launched.context.storageState({ path: resolve(o.out), indexedDB: true } as any);
    await launched.close();
    console.log(JSON.stringify({ state: resolve(o.out) }));
    process.exit(0);
  });

program
  .command("doctor")
  .description("Check Chromium and ffmpeg availability")
  .option("--chromium <path>")
  .action((o) => {
    const cfg = resolveConfig({ browser: { executablePath: o.chromium } });
    let chromium: any;
    try {
      chromium = chromiumInfo(cfg.browser);
    } catch (e) {
      chromium = { error: (e as Error).message };
    }
    console.log(JSON.stringify({ chromium, ffmpeg: ffmpegVersion() ?? "missing", node: process.version, platform: process.platform }, null, 2));
  });

program
  .command("init")
  .description("Write an example scenario file")
  .argument("[file]", "file to create", "scenario.ts")
  .action((file: string) => {
    writeFileSync(
      resolve(file),
      `import { defineScenario } from "agentic-video-recording";

export default defineScenario(
  {
    name: "demo",
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
    output: { width: 1920, height: 1080, fps: 60 },
    // browser: { storageState: "./state.json" },
  },
  async (s) => {
    await s.goto("http://localhost:3000");
    // Setup steps here are not recorded.
    await s.startRecording();
    await s.wait(600);
    await s.click("text=Get started");
    await s.type("input[name=email]", "hello@example.com", { wpm: 240 });
    await s.zoom("form", { scale: 1.6 });
    await s.wait(1200);
    await s.zoomOut();
    await s.stopRecording();
  },
);
`,
    );
    console.log(`Wrote ${resolve(file)}`);
  });

function progress(done: number, total: number) {
  process.stderr.write(`\r  frame ${done}/${total}`);
  if (done === total) process.stderr.write("\n");
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
