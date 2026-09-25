# takeone scenario API

Read this when you edit an exported scenario by hand or write one from scratch. You do not need it for rehearsing.

## Contents

- [Scenario file](#scenario-file)
- [Targets](#targets)
- [Session methods](#session-methods)
- [How waits appear in the video](#how-waits-appear-in-the-video)
- [Config](#config)
- [CLI flags](#cli-flags)

## Scenario file

```ts
import { defineScenario } from "takeone";

export default defineScenario(
  {
    name: "create-project",
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
    output: { width: 1920, height: 1080, fps: 60 },
  },
  async (s) => {
    await s.goto("http://localhost:3000/projects");   // not recorded: before startRecording()
    await s.ready();

    await s.startRecording();
    await s.wait(800);
    await s.type({ role: "textbox", name: "Project name" }, "my-demo-app");
    await s.click({ role: "button", name: "Create project" });
    await s.waitFor({ role: "status", name: /ready/i }, { timeout: 120000 });
    await s.zoom({ role: "status", name: /ready/i });
    await s.wait(1500);
    await s.zoomOut();
    await s.stopRecording();
  },
);
```

Without any `startRecording()`, the whole run is recorded. Recording can be paused and resumed with `pauseRecording()` and `resumeRecording()`, or started and stopped again.

A login lives in `withExplore(scenario, { pages: [], setup: async (page) => { … } })`. `setup` receives a Playwright `Page`.

## Targets

Every action and wait takes a target:

| Form | Example | Use for |
|---|---|---|
| role + name | `{ role: "button", name: "New project" }` | Almost everything. Survives markup changes |
| RegExp name | `{ role: "link", name: /^Issues(?![\w.])/ }` | Names with live counts or badges, or a whole group |
| `nth` | `{ role: "button", name: "Delete", nth: 2 }` | One of several identical controls, by position |
| `near` | `{ role: "button", name: "Delete", near: "walter@example.com" }` | One of several identical controls, by the text next to it. Steadier than `nth` |
| `within` | `{ role: "button", name: "Save", within: "#settings" }` | Scoping the search to a container |
| text | `{ text: "Deployed" }`, `{ text: /saved/i }` | Status and alert text |
| CSS selector | `".monaco-editor"`, `'[data-testid="row"] >> nth=0'` | Elements with no accessible name |
| point | `{ x: "50%", y: 200 }` | Canvas and video |
| rect | `{ x, y, width, height }` | Zooming onto an area |

A named target waits up to `browser.timeout` for the element to appear, so a page that is still rendering does not fail the step. If a name matches several elements, the error lists what sets each apart and suggests `near`.

## Session methods

| Method | Options and notes |
|---|---|
| `goto(url, { waitUntil, edit })` | Navigation. Follow it with `ready()` |
| `ready({ timeout, settle, edit })` | Waits for the network to go quiet and the element count to settle. Use it instead of fixed waits after navigation |
| `wait(ms)` | A pause that stays in the video. Gives the viewer a beat |
| `waitFor(target, { state, timeout, edit })` | `state`: `visible` (default), `attached`, `hidden`, `detached`. There is no `gone` option; use `state: "hidden"` |
| `waitForURL(urlOrRegExp, { timeout, edit })` | |
| `waitForNetworkIdle({ timeout, edit })` | |
| `click(target, { button, hold, clickCount, offset, settle, duration, easing })` | Scrolls the target into view smoothly first when needed. `offset` is px, or a fraction -0.5..0.5 of the element size |
| `dblclick(target, opts)` | |
| `move(target, { duration, easing, offset })`, `hover(…)` | Eased cursor travel on a slight curve. Hover states show |
| `drag(from, to, opts)` | |
| `type(target, text, { wpm, jitter, mistakes, instant, click, settle, showKeys })` | `target: null` types into whatever has focus (editors, terminals). `mistakes: 0.03` adds corrected typos |
| `press(key, { settle, showKeys })` | `"Enter"`, `"Control+K"`, `"Meta+Shift+P"` |
| `scroll({ dy, dx, duration, easing, within })` | Scrolls the page, or the container given by `within` |
| `scrollTo(target, { block, margin, duration })` | `block`: `start`, `center` (default), `end` |
| `zoom(target, { scale, duration, easing, margin, follow, wait })` | The scale fits the target when omitted. A camera move only; the page is untouched |
| `zoomOut({ duration, easing, wait })` | |
| `autoZoom(on)` | Automatic zoom on clicks and typing, per section |
| `keep(fn)`, `lapse(n, fn)`, `trim(fn)` | How the waits inside `fn` appear in the video |
| `run(page => …, label)` | Raw Playwright. Treated as idle time |
| `find(target)`, `findAll(role, name)` | Matches with `nth` and positions, for surveying a group |
| `inventory()` | A fresh element inventory of the current page |
| `mark(name)` | A labelled beat in the event log |
| `page` | The Playwright `Page` |

## How waits appear in the video

By default a wait plays in full, in real time. A slow step such as provisioning is part of the story.

```ts
await s.waitForURL(/\/sql/, { timeout: 300000 });            // shown in full
await s.lapse(8, () => s.waitForURL(/\/sql/));              // 8x time-lapse
await s.trim(() => s.waitForURL(/\/sql/));                  // cut down to idleTrim.keep
await s.waitFor({ text: "Ready" }, { edit: "trim" });       // the same, as an option
```

A cut never lands inside a zoom: the wait plays through the camera move, and only the dead time around it is dropped.

## Config

Set config in the scenario's first argument, with `--config '{…}'`, or with CLI flags. Every value has a default.

```ts
{
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },   // capture; dpr 2 keeps zooms sharp
  output:   { width: 1920, height: 1080, fps: 60, format: "mp4" /* or "webm" */, crf: 18, lossless: false, workers: 6 },
  frame:    { padding: 96, background: "linear-gradient(…)" /* or { image: "bg.png", fit: "cover" } */, borderRadius: 16, shadow: { blur: 60, offsetY: 24, color: "rgba(0,0,0,0.45)" } /* or false */ },
  cursor:   { enabled: true, size: "default" /* small|default|large|xl or px */, style: "arrow" /* or "dot" */, clickRipple: true, clickScale: true },
  zoom:     { auto: true, autoScale: 1.6, autoHold: 1500, autoLead: 600, duration: 700, easing: "smooth", maxScale: 3, margin: 0.12, followCursor: true },
  motion:   { cursorSpeed: "normal" /* slow|normal|fast or px/ms */, minMoveDuration: 350, maxMoveDuration: 1600, clickHold: 90, wpm: 220, typingJitter: 0.35, scrollDuration: 600 },
  idleTrim: { enabled: true, threshold: 1500, keep: 600, protectCamera: true },
  browser:  { headless: true, storageState: "state.json", userDataDir, executablePath, args, locale, timezoneId, colorScheme, timeout: 15000, sameTabLinks: true },
  keys:     { mode: "shortcuts" /* shortcuts|all|manual|off */, platform: "mac" /* or "windows" */, position: "bottom", hold: 1200 },
  dryRun:   { scale: 0.5, contactSheet: true, columns: 3 },
}
```

Easings: `linear`, `smooth`, `snappy`, `spring`, `easeOut`, `easeIn`, or a cubic bezier `[x1, y1, x2, y2]`.

The key overlay shows keyboard shortcuts in a pill at the bottom of the frame. `keys.mode: "all"` also shows typed text.

## CLI flags

These work on `record`, `dry-run` and `render`:

- `--viewport 1920x1080`
- `--dpr 2`
- `--width 3840 --height 2160`
- `--fps 30`
- `--config '{"frame":{"padding":64}}'`
- `--state state.json`
- `--profile <dir>`
- `--chromium <path>`
- `--headed`

`dry-run` adds:

- `--scale 0.35`, for a cheaper contact sheet
- `--fast`, which skips pacing. It's quicker, but not the run the recording will be

`record --no-render` captures only, and `takeone render <dir>` renders it later.

For login state from a real browser: `takeone login --url <app> -o state.json`. This needs a display, so run it on a laptop. Then set `browser.storageState: "state.json"`.
