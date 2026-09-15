# agentic-video-recording

Scripted, agent-friendly screen recordings of web apps with a Screen Studio style finish: smooth synthetic cursor, click ripples, eased zoom and pan, padded background frame. Runs fully headless on Linux or macOS. No display needed.

The core idea: **the agent never drives the browser live.** It writes a scenario file, and a runner replays it on its own clock. Model latency, network hiccups and slow tool calls never show up in the video. All the "look" (cursor, zoom, frame) is applied in a deterministic post pass, so you can re-render the same capture with a different style in seconds.

## Install

```bash
npm install agentic-video-recording
npx avr doctor   # checks Chromium and ffmpeg
```

Chromium is downloaded automatically on first use via Playwright. ffmpeg ships with the package. To use your own binaries:

- `--chromium /path/to/chrome` or `browser.executablePath` in config, or `AVR_CHROMIUM_PATH`
- `FFMPEG_PATH` env var

## Quick start

```bash
npx avr init scenario.ts     # writes an example scenario
npx avr dry-run scenario.ts  # fast: validates selectors, produces one contact sheet
npx avr record scenario.ts   # capture + render -> recordings/<name>-<timestamp>/output.mp4
```

A scenario:

```ts
import { defineScenario } from "agentic-video-recording";

export default defineScenario(
  {
    name: "create-project",
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
    output: { width: 1920, height: 1080, fps: 60 },
    browser: { storageState: "./state.json" }, // already logged in
  },
  async (s) => {
    // Setup. Nothing here is recorded.
    await s.goto("http://localhost:3000");
    await s.click("text=Projects");      // SPA navigation, no URL needed
    await s.waitFor("#project-list");

    await s.startRecording();
    await s.wait(500);
    await s.type("#name", "my-demo-app", { wpm: 220, mistakes: 0.03 });
    await s.click("text=Create");
    await s.waitFor("text=Deployed");     // waiting time is trimmed in post
    await s.zoom("#status", { scale: 1.8 });
    await s.wait(1200);
    await s.zoomOut();
    await s.scrollTo("h2:has-text('Recent')", { block: "start" });
    await s.wait(800);
    await s.stopRecording();
  },
);
```

## Workflow for agents

1. **`avr dry-run scenario.ts`** runs the scenario instantly with no animation and screenshots every step into a single `contact-sheet.jpg`. Look at that one image to confirm selectors and app state. Use `--scale 0.35` for a cheaper image. Exit code 1 and an error tile if a step fails.
2. **`avr record scenario.ts`** drives the real browser with human pacing, captures frames, then renders. Prints JSON with the video path and a `output-keyframes.jpg` tile sheet of the final video.
3. **`avr render <dir>`** re-renders an existing capture with a different look, size, fps or format. No browser driving involved.

Use `--no-render` on `record` for a pure two-pass flow.

## Session API

Targets can be a selector string, a Playwright `Locator`, a point `{ x, y }` (numbers or percentages like `"50%"`), or a rect `{ x, y, width, height }`.

| Method | Notes |
| --- | --- |
| `goto(url)` | Navigation. Time spent is logged as idle. |
| `waitFor(target, { state })`, `waitForURL(url)`, `waitForNetworkIdle()` | Idle waits, trimmed in post when longer than `idleTrim.threshold`. |
| `wait(ms)` | Intentional pause, kept in the video. |
| `move(target)` / `hover(target)` | Eased cursor travel along a slight curve. Real pointer moves, so hover states show. |
| `click(target, { button, hold, clickCount, offset })`, `dblclick` | Scrolls the target into view smoothly first if needed. |
| `drag(from, to)` | Press, move, release. |
| `type(target, text, { wpm, jitter, mistakes, instant })` | Human cadence. `null` target types into the focused element. |
| `press("Control+K")` | Key or chord. |
| `scroll({ dy, duration, within })`, `scrollTo(target, { block })` | Eased programmatic scroll of the page or the right scroll container; pointer position does not matter. |
| `zoom(target, { scale, duration, easing, margin, follow })` | Camera move. Scale is fitted to the target when omitted. |
| `zoomOut()` | Back to full frame. |
| `autoZoom(false)` / `autoZoom(true)` | Toggle automatic click zoom for a section. |
| `startRecording()`, `pauseRecording()`, `resumeRecording()`, `stopRecording()` | Recording boundaries. Without any call, the whole run is recorded. |
| `run(page => ...)` | Escape hatch for raw Playwright, treated as idle. |
| `page` | The Playwright page. |

## Configuration

Every value has a default and can be set in the scenario, via `--config '{...}'`, or with CLI flags (`--viewport 1920x1080 --dpr 2 --width 3840 --height 2160 --fps 30`).

```ts
{
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 }, // browser size; dpr 2 keeps zooms crisp
  output:   { width: 1920, height: 1080, fps: 60, format: "mp4", crf: 18, lossless: false, workers: 6 },
  frame:    { padding: 96, background: "linear-gradient(...)" /* or { image } */, borderRadius: 16, shadow: { blur, offsetY, color } },
  cursor:   { enabled: true, size: "default" /* small|default|large|xl or px */, style: "arrow" | "dot", clickRipple: true, clickScale: true },
  zoom:     { auto: true, autoScale: 1.6, autoHold: 1500, autoLead: 600, duration: 700, easing: "smooth", maxScale: 3, margin: 0.12, followCursor: true },
  motion:   { cursorSpeed: "normal" /* slow|normal|fast or px/ms */, minMoveDuration: 350, maxMoveDuration: 1600, easing: "smooth", clickHold: 90, wpm: 220, typingJitter: 0.35, scrollDuration: 600 },
  idleTrim: { enabled: true, threshold: 1500, keep: 600 },
  browser:  { executablePath, headless: true, storageState, userDataDir, args, locale, timezoneId, colorScheme, timeout: 15000, sameTabLinks: true },
  capture:  { format: "jpeg", quality: 92 },
  dryRun:   { scale: 0.5, contactSheet: true, columns: 3 },
}
```

Easings: `linear`, `smooth`, `snappy`, `spring`, `easeOut`, `easeIn`, or a cubic bezier `[x1, y1, x2, y2]`.

Output and browser size are independent. Record a 1920x1080 viewport at 2x and render to 4K, or to 1080p, from the same capture.

## Authenticated state

```bash
npx avr login --url https://app.example.com -o state.json   # needs a display; do this on your Mac
```

Log in, press Enter, and the cookies, localStorage and IndexedDB are saved. Point `browser.storageState` at the file. For anything else (extensions, service workers), pass a real profile directory with `browser.userDataDir` or `--profile`.

## How it works

- **Runner**: Playwright drives headless Chromium. Frames come from the DevTools screencast at native resolution, each with a timestamp. Every pointer move, click, key, scroll, zoom and wait is written to `manifest.json`.
- **Compositor**: a canvas page rendered frame by frame across several worker browsers, each piping to its own ffmpeg segment, concatenated at the end. Cursor motion and camera moves are computed from the event log, so they are always smooth regardless of how the capture went.
- **Output**: H.264 MP4 by default, VP9 WebM optional.

## Programmatic use

```ts
import { recordScenario, renderRecording, dryRunScenario } from "agentic-video-recording";
import scenario from "./scenario.js";

const rec = await recordScenario(scenario, { outDir: "out/demo" });
await renderRecording({ recordingDir: rec.outDir, config: { frame: { background: "#000" } } });
```

## Limitations

- Web only. Native apps are a different capture path, though the compositor and scenario format would carry over.
- Real-time capture: pages that repaint faster than the screencast can encode may drop intermediate frames. Cursor and camera are unaffected.
- No GPU acceleration in headless Chromium, so heavy WebGL pages render slower.
