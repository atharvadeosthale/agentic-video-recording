# takeone

Scripted, agent-friendly screen recordings of web apps with a Screen Studio style finish: smooth synthetic cursor, click ripples, eased zoom and pan, padded background frame. Runs fully headless on Linux or macOS. No display needed.

The core idea: **the agent never drives the browser live.** It writes a scenario file, and a runner replays it on its own clock. Model latency, network hiccups and slow tool calls never show up in the video. All the "look" (cursor, zoom, frame) is applied in a deterministic post pass, so you can re-render the same capture with a different style in seconds.

## Install

```bash
npm install takeone
npx takeone doctor   # checks Chromium and ffmpeg
```

Chromium is downloaded automatically on first use via Playwright. ffmpeg ships with the package. To use your own binaries:

- `--chromium /path/to/chrome` or `browser.executablePath` in config, or `TAKEONE_CHROMIUM_PATH`
- `FFMPEG_PATH` env var

## Quick start

```bash
npx takeone do goto http://localhost:3000   # rehearse live: prints the numbered view of the page
npx takeone do click 7                      # act by number; every step prints what changed
npx takeone session export scenario.ts      # the rehearsal becomes the scenario
npx takeone record scenario.ts              # capture + render -> recordings/<name>-<timestamp>/output.mp4
```

A scenario:

```ts
import { defineScenario } from "takeone";

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
    await s.click({ role: "link", name: "Projects" });  // SPA navigation, no URL needed
    await s.ready();

    await s.startRecording();
    await s.wait(500);
    await s.type({ role: "textbox", name: "Project name" }, "my-demo-app", { wpm: 220, mistakes: 0.03 });
    await s.click({ role: "button", name: "Create project" });
    await s.waitFor({ role: "status", name: /deployed/ });  // trimmed in post
    await s.zoom({ role: "status", name: /deployed/ }, { scale: 1.8 });
    await s.wait(1200);
    await s.zoomOut();
    await s.scrollTo({ role: "heading", name: "Recent deployments" }, { block: "start" });
    await s.wait(800);
    await s.stopRecording();
  },
);
```

## Workflow for agents

Run `takeone guide` for this on one screen.

Rehearse in a live browser with plain words, and let the rehearsal write the scenario. There is no scenario file to author, no selector to guess, and no probe script to write.

```bash
takeone do goto http://localhost:3000/projects       # the first command starts the browser
takeone do click "new project"
takeone do type "name" "acme-prod"
takeone do wait-for "Database ready" --timeout 120000
takeone do zoom "heading:Query results"
takeone do zoom-out
takeone session export demo.ts             # replays the kept steps, then writes the file
takeone record demo.ts
```

For a logged-in app, pass `--scenario <file>` on the first command. The file only needs an `explore.setup` that logs in. The session logs in once and every later command reuses it.

### Seeing the page

`takeone look`, and every `takeone do` that lands on a new page or opens a dialog, prints the view. Every element on screen gets a number and is grouped by the region it sits in. Each line also shows what the page's markup says the element does:

```
$ takeone do goto http://localhost:3000/projects
✓ #1 await s.goto("http://localhost:3000/projects");
/projects  "Projects - Acme"
header
  1 link "Acme" [icon logo] → /
  2 button "Search" [icon search] (opens dialog)
sidebar "Project"
  3 link "Overview" → /console/acme/overview
  4 link "Auth" [current] → /projects
main
  9 heading "Auth"
  10 tab "Users" [selected]
  11 tab "Policies"
  12 button "Create user"
  13 button [icon ellipsis] (opens menu)
  14 switch "Email alerts" [off]
off screen: 22 more elements. Headings: 30 "Sessions", 41 "Security"
view: /tmp/takeone-view-9222/001-step1.jpg
```

The view file is a screenshot with the same numbers drawn on it. Open it when the text is not enough, for example for icons, layout or chart contents. Act by number: `takeone do click 12`, `takeone do type 5 "demo"`, `takeone do zoom 14`. The export never writes a number. Each one becomes a role and name address, so the scenario replays after the page changes.

Everything in a line is read from the markup. Nothing is clicked or hovered to learn it:

- `→` is where a link goes.
- `(opens menu)` comes from the element's `aria-haspopup` attribute.
- `[on]`, `[selected]`, `[current]`, `[expanded]` and `[= "value"]` are the element's current state.
- `[icon trash-2]` is the icon's class name (lucide, octicon, font awesome, material and others), which names buttons that have no text.
- `(covered by …)` names an element that sits on top of this one and would take a click at its centre.

Off-screen content is summarised as its headings. `scroll-to <n>` brings an element into view, and `look --all` lists everything. `--filter <text>` and `--role <role>` search the whole page. Views are kept in a temporary directory, which holds the last 12 and is deleted when the session stops.

### Every step reports what changed

```
$ takeone do click 12
✓ #6 await s.click({ role: "button", name: "Create user" });
  matched 12 button "Create user"
+ 31 textbox "Name"
+ 32 textbox "Email"
~ 14 switch "Email alerts" now [on]
view: /tmp/takeone-view-9222/006-step6.jpg
```

The first line is the scenario line that was journaled. The rest is what changed since the previous page state:

- elements that appeared (`+`, with their numbers) or disappeared (`-`)
- state changes (`~`)
- dialogs, new headings and alerts
- a changed URL
- page errors or failed requests (`!`)

A new page or a newly opened dialog prints the whole view instead. With a dialog open, the view lists only the dialog.

A target is a number from the latest view, or plain words (`"new project"`). With plain words the best match wins, `--nth` picks another match, and `--role` narrows the search. Explicit forms also work: `button:Create`, `text=Deployed`, `css=.monaco-editor`, `640,360`. To reach a control whose name is a number, use `button:2`. When another element covers the target, the output says which element receives the click.

### Exploring clicks and recording clicks

You do not declare which clicks are for the video. Every step is journaled with a fingerprint of the page state. Steps that return to an earlier state, such as opening a menu and closing it, are marked as a detour and left out of the export.

```bash
takeone mark setup          # unrecorded setup begins: put the app in the state the video starts from
takeone mark start          # the recording begins
takeone journal             # where each step landed: explore, setup, record, detour, drop
takeone journal drop 5-8    # override
takeone journal keep 6
takeone journal setup 3     # move a step you already took into the setup
```

Both marks are optional. With neither, every step is recorded. With only `takeone mark start`, everything before it was looking around. Setup steps are exported before `startRecording()`, run back to back with no pacing, and are replayed along with the recorded steps when the export verifies the path. A detour is only looked for inside one section, so setup can open something that the recording then closes.

`takeone session export` replays the kept steps in a fresh tab of the same browser before it writes the file. If a kept step depended on a dropped one, the replay fails at that step and shows what the page said.

### Exporting into a file that already has contents

An exported file keeps its recorded steps between two marker comments, `takeone:steps-begin` and `takeone:steps-end`. Setup steps get their own pair before `startRecording()`, `takeone:setup-begin` and `takeone:setup-end`. A later export replaces only those blocks, so the config, imports, helpers and login around them are kept.

```ts
    await s.startRecording();
    // takeone:steps-begin 044282aba2 (replaced by `takeone session export`; edits outside this block are kept)
    await s.click({ role: "button", name: "Create project" });
    // takeone:steps-end
    await s.stopRecording();
```

To add recorded steps to a scenario you wrote yourself, such as one that holds your login, put the two markers where the steps belong and export into that file:

```ts
export default withExplore(
  defineScenario({ name: "demo" }, async (s) => {
    await s.run(login, "login");
    await s.goto(`${BASE}/projects`);
    await s.startRecording();
    // takeone:steps-begin
    // takeone:steps-end
    await s.stopRecording();
  }),
  { setup: login, pages: [] },
);
```

The export refuses to write, with a non-zero exit code, in four cases:

- The file has contents but no markers.
- The journal has setup steps and the file has no setup markers. Add the pair before `startRecording()`.
- The lines between the markers were edited by hand since the last export. The hash on the first marker detects this.
- `--force` is used on the scenario the session logged in from, because that would delete the login.

`--force` overwrites the whole file in the first two cases. The file's own `goto` sits outside the block, so check it if the recorded path now starts somewhere else.

### Failures are loud

- A miss lists the closest elements and what the page shows: headings, alerts and body text. A login page or a "not found" page is named as such.
- `find`, `explore`, `look` and `do` give up with a non-zero exit code instead of hanging. `TAKEONE_BUDGET=<seconds>` raises the limit.
- A misspelled session method such as `s.waitForUrl()` fails when the scenario loads, with a suggestion, before any browser starts.
- A screenshot that times out no longer discards the inventory.

### The scripted flow

Writing the scenario by hand still works, and the exported file is an ordinary scenario you can edit.

1. **`takeone dry-run scenario.ts`** runs the scenario at the same pace as a recording, with the same typing cadence, waits, cursor travel and click holds. It skips capture and render, and screenshots every step into one `contact-sheet.jpg`. A dry run that passes is a recording that will pass. `--scale 0.35` makes the sheet cheaper. `--fast` skips all pacing; it is quicker, but the page no longer sees what the recording will send it, so it can pass where the recording fails.
2. **`takeone record scenario.ts`** drives the real browser with human pacing, captures, then renders. Prints the video path and an `output-keyframes.jpg` sheet.
3. **`takeone render <dir>`** re-renders an existing capture with a different look, size, fps or format. No browser involved.

Use `--no-render` on `record` for a pure two-pass flow. `takeone explore` and `takeone find`, described below, inventory whole pages by URL.

## MCP server

`takeone mcp` runs everything above as a local MCP server over stdio. It launches Chrome itself, so an agent can rehearse, export, dry-run and record without a shell. Each `takeone_do` and `takeone_look` reply carries the numbered screenshot itself, so one call both acts and shows the page.

```bash
claude mcp add takeone -- npx takeone mcp          # Claude Code
codex mcp add takeone -- npx takeone mcp           # Codex
```

Tools: `takeone_start` (an optional login through a scenario's `explore.setup`, headed, viewport), `takeone_do`, `takeone_look`, `takeone_mark`, `takeone_journal`, `takeone_export`, `takeone_dry_run` (returns the contact sheet), `takeone_record` (returns the keyframe sheet), `takeone_stop`. The server and the CLI share one session, so an agent can use both. The browser the server opened closes when the client disconnects. The server also binds to `takeone-mcp`.

To run a second session on the same machine, set a different port, for example `TAKEONE_SESSION_PORT=9322`. It gets its own browser and profile.

## Agent skill

A skill that teaches coding agents the whole workflow ships in `skills/takeone`. Install it with the [skills](https://skills.sh) CLI:

```bash
npx skills add atharvadeosthale/takeone
```

## Exploring a page

Add an `explore` plan to the scenario. It is optional: scenarios without one still record normally.

```ts
import { withExplore, defineScenario } from "takeone";

export default withExplore(
  defineScenario({ name: "console-tour" }, async (s) => {
    // ...the recording
  }),
  {
    baseUrl: "http://localhost:3000",
    setup: async (page) => {
      // Runs once, before the walk. Log in, dismiss a banner, enable a mode.
      await page.goto("http://localhost:3000/sign-in");
      await page.fill('input[name="email"]', "me@example.com");
      await page.fill('input[name="password"]', "...");
      await page.click('button[type="submit"]');
      await page.waitForURL(/organizations/);
    },
    pages: [
      { path: "/projects/abc" },
      { path: "/projects/abc/databases" },
      // Reach a sub-view before inventorying it.
      {
        path: "/projects/abc/databases",
        prepare: async (page) => {
          await page.getByRole("button", { name: "New project" }).click();
        },
      },
    ],
  },
);
```

```bash
takeone explore scenario.ts            # -> .takeone/inventory.json, pages.jpg, inventory.html
takeone explore scenario.ts --list     # print the inventory instead of only writing files
takeone explore http://localhost:3000/pricing --base http://localhost:3000   # a URL, no scenario
```

The index lands at `.takeone/inventory.json`. Handles stay resolvable across later runs: exploring one page does not drop entries for pages you did not revisit.

### Reading the inventory

```
$ takeone explore scenario.ts
[1/2] http://localhost:3000/projects/abc
  81 elements, 0 ambiguous
[2/2] http://localhost:3000/projects/abc/databases
  61 elements, 8 ambiguous
Index -> .takeone/inventory.json
```

```jsonc
{ "handle": "@e20", "role": "button", "name": "New project", "nth": 1,
  "stable": { "kind": "aria-label", "value": "New project" },
  "x": 1284, "y": 134, "width": 152, "height": 36 }
```

Each entry carries the `target` to hand to the session, so you rarely have to construct an address yourself:

```jsonc
"role": "button", "name": "New project",
"target": { "role": "button", "name": "New project" }   // pass this straight to s.click()
```

For a region whose name is its live content, the suggested target is a text match, and for one that is still empty it is the handle:

```jsonc
"role": "status", "name": "",  "target": "@e7"   // fills in later; the handle keeps working
```

Elements that share a role and a name are flagged, so ambiguity is something you read up front rather than discover as a timeout:

```
@e32 img "Primary" -> {"role":"img","name":"Primary","nth":1}  (or aria-label=Primary)  — 3 share this role+name
```

### Asking what is on a page

`takeone find` answers one question without writing a scenario. Omit `--name` to list everything with a role.

```bash
takeone find http://localhost:3000/projects/abc/databases --role link --name "PostgreSQL" --state state.json
takeone find http://localhost:3000/pricing --role button
```

It prints each match with a `nth` index and its screen position, which is usually enough to pick an address in one shot.

## Addressing elements

`Target` accepts, most durable first:

```ts
await s.click({ role: "button", name: "New project" });       // what it is
await s.click({ role: "link", name: /Postgres/ });                // a group
await s.click({ role: "button", name: "Delete", nth: 2 });        // pick from a group, by position
await s.click({ role: "heading", name: "Store", near: "store-132023" }); // pick from a group, by what is next to it
await s.click({ role: "button", name: "Delete", within: "#panel" });
await s.click({ text: "Deployed" });                              // by visible text
await s.click("@e20");                                            // an explored handle
await s.click('#db-name');                                        // a CSS selector
await s.click({ x: "50%", y: 200 });                              // a point
```

Prefer `{ role, name }`. It describes the element rather than its position in the DOM, so it survives the markup churn that breaks CSS selectors. Use `{ text }` for a region whose name is its live content, such as a status or alert, and `@eNN` when you want a short, stable reference to something already explored. Selectors still work, and points are still there for canvas and video.

Every readiness wait and every action accepts these, so `waitFor({ role: "status", name: /saved/ })` polls until the region reports that text.

### Groups and rules

A RegExp name addresses every match, so you can act on a whole set instead of one element.

```ts
// Survey the group, then choose.
const cards = await s.find({ role: "link", name: /PostgreSQL/ });
// [{ nth: 1, name: "Production PostgreSQL...", x: 454, y: 186, ... }, ...]

// Move across every card in turn.
for (const card of cards) {
  await s.move({ role: "link", name: /PostgreSQL/, nth: card.nth });
  await s.wait(400);
}

// Zoom onto a group to frame a whole rule of buttons at once.
await s.zoom({ role: "button", name: /^(Filters|All types)$/ });
```

Kinds of groups worth reaching for:

- **A repeated list**: `/^Delete/` over table rows, every "Tabs"/"Modal" button in a component matrix.
- **A rule of related controls**: a toolbar, a tab strip, a pagination footer.
- **A family across pages**: `/Create (database|table|collection)/`, so one address covers the same action in several places.

### Handles are per page

`@e1` is the first element on *every* page, so a handle is only meaningful with a URL. A handle resolves against the page that defined it, and the error names the other pages that define it when it does not belong here.

### Failures explain themselves

A miss does not wait for a timeout and then throw a Playwright stack trace. It reports what is actually on the page:

```
No element matched getByRole(button, /Deploy to production/i).
  Closest elements on http://localhost:3000/projects/abc/databases:
    @e44 button "Go to first page" at (1214,541)
    @e45 button "Go to previous page" at (1246,541)
```

### Breaking ties with `near`

When several elements share a role and a name, `nth` picks by position, which changes as soon as the list does. `near` picks by content: it names text that sits in the same card or row as the element you mean, such as a record id.

```ts
await s.click({ role: "heading", name: "Store", near: "store-132023" });
await s.click({ role: "button", name: "Delete", near: "walter@example.com" });
```

The match that shares the smallest container with that text wins. `takeone do click "store" --nth 3` journals the step with `near` on its own when the tied elements have text that sets them apart.

An ambiguous address lists its siblings, what sets each apart, and the fix:

```
getByRole(heading, "Store") matched 3 elements.
  nth=1 at (25,122)  near "store-131455"
  nth=2 at (341,122)  near "store-131601"
  nth=3 at (657,122)  near "store-132023"
Add near: "<text>" to pick one by what is next to it (steadier than nth, which depends on order), pass a RegExp name to address the group, or use "within" to scope the search.
```

## Waits in the video

A wait plays **in full, in real time, by default**. A slow step such as provisioning a database is part of the story, so it is shown rather than cut. Trimming is opt-in per wait.

```ts
await s.waitForURL(/\/sql/, { timeout: 300000 });                    // shown in full (default)
await s.lapse(8, () => s.waitForURL(/\/sql/));                      // 8x time-lapse
await s.trim(() => s.waitForURL(/\/sql/));                          // shortened to idleTrim.keep
await s.waitForURL(/\/sql/, { edit: "trim" });                      // same, as an option
```

The edit can be passed as an option on any waiting call (`goto`, `waitFor`, `waitForURL`, `waitForNetworkIdle`, `ready`) or applied to a block with `keep()`, `lapse()`, or `trim()`. Time-lapse shows the whole wait, compressed, so a 26s provisioning step reads as a few seconds of visible progress instead of a blink.

### Cuts never land inside a zoom

Automatically shortened waits are split so no cut begins during a camera move. When a wait and a zoom overlap, the wait plays through the zoom whole and only the remaining dead time is dropped. A zoom therefore never jumps to its midpoint, and no camera move is ever split across a cut. `idleTrim.protectCamera` (default on) controls this.

## Interactive sessions

`takeone do` starts this session for you on its first command, so you rarely need to manage it. Without one, `takeone explore`, `takeone find`, and recordings relaunch a browser and re-login on every call. When you are working against a logged-in app, start one long-lived browser instead and let every command attach to it.

```bash
takeone session start --scenario scenario.ts    # launches once, runs explore.setup for login
takeone session status                          # running | stale | none, plus the current URL

takeone explore scenario.ts                     # attaches: "already logged in", no relaunch
takeone find /projects/abc/databases --role button --name "Create"   # no --base needed
takeone session stop
```

With a session running, `takeone find` takes a path and uses the session's own origin, so no `--base` or state file is needed. Pass `--no-session` to any command to force a fresh browser.

This is the fastest loop when you are discovering what to record: explore, ask `find`, explore again, and only launch a browser once for the actual recording.

## Tips for agents

**Rehearse first.** `takeone do` starts a session on its own, logs in once with `--scenario`, and prints what every step changed. Export the rehearsal instead of writing the scenario from memory.

**Explore for the whole-page view.** `takeone explore` and `takeone find` attach to the same session, so they cost no relaunch. Use them when you want every element on a page by URL; use `takeone do` and `takeone look` for states that only exist after a click.

**Reach for `ready()` instead of `wait(3000)`.** Single-page apps render after `load`, so a fixed wait is either too short or wasted. `ready()` waits briefly for the network to go quiet, then waits for the interactive element count to settle, and reports how many elements it found. An app that polls forever still becomes ready, because the element count decides. If nothing visible settles within the timeout, `ready()` throws instead of reporting success.

```ts
await s.goto(url);
await s.ready();                       // not await s.wait(6000)
await s.click({ role: "button", name: "New project" });
```

**Say what the element is.** `{ role: "button", name: "New project" }` outlives a CSS selector. Use a selector only when there is no accessible name to point at.

**Ask, do not guess.** When you are unsure an element exists or what it is called, `await s.find({ role, name })`, `await s.inventory()`, or `takeone find` answers directly. `await s.handles()` lists the explored handles for the current page.

**Work in groups.** If the recording touches several similar controls, address the family with a RegExp once, then iterate. That is one address to get right instead of one per element.

**Keep the index warm.** `takeone explore` merges into the existing index, so re-exploring the page you changed leaves every other handle working. Re-run it after a UI change rather than editing handles by hand.

**Do not write throwaway probe scripts.** When you need to know what is on a page or what a click did, `takeone do` and `takeone look` answer from the browser that is already open. `takeone find`, `takeone explore`, and `await s.inventory()` cover whole pages. A hand-written Playwright script relaunches the browser, re-logs-in, and gives you one answer; `find` against a live session gives you the same answer from the browser that is already open. If you catch yourself about to write `probe.mjs`, run `takeone find` instead.

**Check the dry run, then record.** `takeone dry-run` is one image and no encoder, and it paces the page exactly as the recording will. Everything that can be wrong about an address or a timing is visible there.

**Prefer many short recordings to one long take.** `startRecording`/`stopRecording` can be called repeatedly; `record --no-render` plus `takeone render` keeps re-styling free.

## Session API

Targets can be a `@eNN` handle, a `{ role, name }` pair, a Playwright `Locator`, a selector string, a point `{ x, y }` (numbers or percentages like `"50%"`), or a rect `{ x, y, width, height }`.

| Method | Notes |
| --- | --- |
| `goto(url)` | Navigation. Time spent is logged as idle. |
| `keep(fn)` / `lapse(n, fn)` / `trim(fn)` | How a wait appears: full real time (default), `n`x time-lapse, or shortened to `idleTrim.keep`. |
| `ready()` / `readyForInteraction()` | Waits for network idle and a stable element count. Use after navigation instead of a fixed wait. |
| `find(target)` / `findAll(role, name)` | Every element matching a role+name target (RegExp matches a group). Returns `nth` and positions. |
| `inventory()` | Fresh inventory of the current page, mid-run. |
| `handles()` | Explored handles for the current page, as `handle`, `role`, `name`, `nth`. |
| `waitFor(target, { state })`, `waitForURL(url)`, `waitForNetworkIdle()` | Idle waits, trimmed in post when longer than `idleTrim.threshold`. |
| `wait(ms)` | Intentional pause, kept in the video. |
| `move(target)` / `hover(target)` | Eased cursor travel along a slight curve. Real pointer moves, so hover states show. |
| `click(target, { button, hold, clickCount, offset })`, `dblclick` | Scrolls the target into view smoothly first if needed. |
| `drag(from, to)` | Press, move, release. |
| `type(target, text, { wpm, jitter, mistakes, instant, showKeys })` | Human cadence. `null` target types into the focused element. Typed text appears in the key pill when `keys.mode` is `all` or `showKeys` is true. |
| `press("Control+K", { showKeys })` | Key or chord. Shown in the on-screen key pill per `keys.mode`; `showKeys` forces it on or off. |
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
  keys:     { mode: "shortcuts" /* shortcuts|all|manual|off */, hold: 1200, gap: 900, platform: "mac", position: "bottom", offset: 0.1, fontSize: 34 },
  dryRun:   { scale: 0.5, contactSheet: true, columns: 3 },
  explore:  { index: ".takeone/inventory.json", max: 250, scroll: true },
}
```

**Key overlay.** A Screen Studio style pill at the bottom of the frame shows what was pressed. `shortcuts` (default) shows chords like ⌘K and special keys like Enter; `all` also shows typed text as it is typed; `manual` shows only steps with `showKeys: true`; `off` disables it. Set `keys.platform` to `windows` for Ctrl/Alt labels.

Easings: `linear`, `smooth`, `snappy`, `spring`, `easeOut`, `easeIn`, or a cubic bezier `[x1, y1, x2, y2]`.

**Explore.** `explore.index` is where the handle index is written, `explore.max` caps elements inventoried per page, and `explore.scroll` walks the page so off-screen elements are included. Set `indexPath` on the scenario to point handle resolution at a different index file.

Output and browser size are independent. Record a 1920x1080 viewport at 2x and render to 4K, or to 1080p, from the same capture.

## Authenticated state

```bash
npx takeone login --url https://app.example.com -o state.json   # needs a display; do this on your Mac
```

Log in, press Enter, and the cookies, localStorage and IndexedDB are saved. Point `browser.storageState` at the file. For anything else (extensions, service workers), pass a real profile directory with `browser.userDataDir` or `--profile`.

## How it works

- **Runner**: Playwright drives headless Chromium. Frames come from the DevTools screencast at native resolution, each with a timestamp. Every pointer move, click, key, scroll, zoom and wait is written to `manifest.json`.
- **Compositor**: a canvas page rendered frame by frame across several worker browsers, each piping to its own ffmpeg segment, concatenated at the end. Cursor motion and camera moves are computed from the event log, so they are always smooth regardless of how the capture went.
- **Output**: H.264 MP4 by default, VP9 WebM optional.

## Programmatic use

```ts
import { recordScenario, renderRecording, dryRunScenario } from "takeone";
import scenario from "./scenario.js";

const rec = await recordScenario(scenario, { outDir: "out/demo" });
await renderRecording({ recordingDir: rec.outDir, config: { frame: { background: "#000" } } });
```

## Limitations

- Web only. Native apps are a different capture path, though the compositor and scenario format would carry over.
- Real-time capture: pages that repaint faster than the screencast can encode may drop intermediate frames. Cursor and camera are unaffected.
- No GPU acceleration in headless Chromium, so heavy WebGL pages render slower.
