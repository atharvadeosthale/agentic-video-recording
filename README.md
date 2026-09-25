# takeone

Your coding agent records polished demo videos of web apps. You get a smooth cursor, click ripples, eased zooms and a padded frame, the look Screen Studio made popular. It renders headless, so it runs on a Linux server as well as a Mac.

An agent driving a browser live makes a jumpy video, because every pause while the model thinks ends up on camera. takeone splits the job in two. The agent rehearses in a live browser, and the rehearsal becomes a script. The script then replays on its own clock, so the video never waits on the model. The cursor, zoom and frame are drawn afterwards, which means you can restyle a take without recording it again.

## Get started

```bash
npx skills add atharvadeosthale/takeone
```

Then ask your agent for a video:

> Record a 30 second demo of creating a project on localhost:3000, and zoom in on the new project's ID at the end.

The skill teaches the agent the whole job:

1. Install the package.
2. Set up Chromium.
3. Rehearse the path and export it as a scenario.
4. Dry-run the scenario to check it.
5. Render `output.mp4`.

It works with Claude Code, Codex, Cursor and the other agents the [skills CLI](https://skills.sh) supports.

### The MCP server

Agents can drive takeone through its CLI, but the MCP server is faster. Each MCP reply carries a screenshot, so one call acts on the page and shows the result.

```bash
claude mcp add takeone -- npx -y takeone mcp
codex mcp add takeone -- npx -y takeone mcp
```

Other clients take `{"command": "npx", "args": ["-y", "takeone", "mcp"]}`. The MCP server and the CLI share one browser, so an agent can switch between them mid-task.

## Doing it yourself

Everything the agent does, you can do yourself from a terminal.

```bash
npm i -D takeone
npx takeone setup
```

`setup` downloads Chromium once, about 650 MB. Then it checks ffmpeg and starts a headless browser to prove everything works. If a Linux server is missing Chromium's system libraries, `npx takeone setup --with-deps` installs them with sudo.

### Rehearse

The first command opens the browser. Every command prints what's on screen, numbered, grouped by region, with what each element does:

```
$ npx takeone do goto http://localhost:3000
✓ #1 await s.goto("http://localhost:3000/");
/  "Acme Dashboard"
nav
  1 link "Overview" → /
  2 link "Projects" → /projects
main
  4 heading "Create a project"
  5 textbox "Project name"
  6 button "Create project"
  7 button [icon ellipsis] (opens menu)
view: /tmp/takeone-view-9222/001-step1.jpg (the 1920x1080 page, scaled down)
```

The `view:` file is a screenshot with the same numbers drawn on it. Act by number:

```
$ npx takeone do type 5 "acme-prod"
$ npx takeone do click 6
✓ #3 await s.click({ role: "button", name: "Create project" });
  matched 6 button "Create project"
+ 8 status "Creating acme-prod…"
```

After the first view, each step prints only what changed. `+` marks new elements, `-` removed ones, and `~` changed state. Alerts and page errors show up too.

takeone reads each element's purpose from the page's markup. It never clicks anything to find out what it does, because a Delete button clicked just to see what it does would really delete.

You can also name targets in plain words (`click "create project"`), as `role:name` (`button:Create`), with `text=…` or `css=…`, or as a point (`640,360`).

### Mark, export, record

```bash
npx takeone mark start                # the video starts here; anything earlier was looking around
npx takeone do zoom 8                 # a camera move, nothing on the page changes
npx takeone session export demo.ts    # replays the path to prove it, then writes the scenario
npx takeone dry-run demo.ts           # full recording pace, one contact sheet image
npx takeone record demo.ts            # recordings/demo-<time>/output.mp4
```

Steps that bring the page back to an earlier state, like opening a menu and closing it again, are dropped from the export automatically. `npx takeone journal` shows where every step landed and lets you keep or drop any of them.

A dry run paces the page exactly like the recording, so if the dry run passes, the recording will too. Check the contact sheet before you record.

## Scenarios

The export is a plain TypeScript file, and you can edit it by hand:

```ts
import { defineScenario } from "takeone";

export default defineScenario({ name: "create-project" }, async (s) => {
  await s.goto("http://localhost:3000/projects");
  await s.ready();

  await s.startRecording();
  await s.type({ role: "textbox", name: "Project name" }, "acme-prod");
  await s.click({ role: "button", name: "Create project" });
  await s.waitFor({ role: "status", name: /ready/i }, { timeout: 120000 });
  await s.zoom({ role: "status", name: /ready/i });
  await s.wait(1500);
  await s.zoomOut();
  await s.stopRecording();
});
```

Anything before `startRecording()` stays out of the video. Targets name what an element is, `{ role, name }`, rather than where it sits in the DOM, so a scenario keeps working through markup changes.

Re-exporting into the same file only replaces the steps between the `// takeone:steps-begin` and `// takeone:steps-end` markers. Your config, helpers and edits outside those markers are kept.

The full API, with every method, option and config key, is in [`skills/takeone/references/scenario-api.md`](skills/takeone/references/scenario-api.md).

## The look

Capture and output are configured separately. The default captures a 1920x1080 browser at 2x, so zooms stay sharp, and renders a 1080p, 60 fps MP4. For 4K, raise `output` to 3840x2160 and capture at `deviceScaleFactor: 3`.

```ts
defineScenario({
  name: "demo",
  frame: { padding: 96, background: "linear-gradient(135deg, #1e1b4b, #be185d)", borderRadius: 16 },
  cursor: { size: "large", clickRipple: true },
  zoom: { auto: true, autoScale: 1.6 },
  keys: { mode: "shortcuts" },
  output: { width: 1920, height: 1080, fps: 60 },
}, async (s) => { /* … */ });
```

A recording keeps its raw frames, so `npx takeone render recordings/demo-<time>` renders it again with a different background, cursor or size. Nothing is recorded again.

Waits play in real time by default, because a 20 second deploy is part of the story. `s.lapse(8, () => …)` shows a long wait as a time-lapse. `s.trim(() => …)` cuts it short. A cut never lands in the middle of a zoom.

## Logged-in apps

Put the login in a scenario's `explore.setup`:

```ts
import { defineScenario, withExplore } from "takeone";

export default withExplore(defineScenario({ name: "login" }, async () => {}), {
  pages: [],
  setup: async (page) => {
    await page.goto("http://localhost:3000/login");
    await page.fill('input[name="email"]', process.env.DEMO_EMAIL!);
    await page.fill('input[name="password"]', process.env.DEMO_PASSWORD!);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard/);
  },
});
```

Start the rehearsal with it: `npx takeone do goto http://localhost:3000 --scenario login.ts`. The session logs in once. Scenarios exported from that session run the same login before they record.

`npx takeone login --url https://app.example.com -o state.json` saves a real login from a visible browser instead, so it needs a display. Point `browser.storageState` at the file.

## How it works

Playwright drives headless Chromium. Frames come from the DevTools screencast at full resolution, and every pointer move, click, key press, scroll, zoom and wait goes into a `manifest.json`.

The compositor renders the video from that log, split across several browser workers that each encode a segment with ffmpeg. The cursor path and camera moves are computed from the log, not from the capture, so they stay smooth even when the page stutters.

The output is H.264 MP4 by default, or VP9 WebM.

## Limitations

- Web apps only. Native desktop apps aren't supported.
- Pages that repaint faster than the screencast can encode may drop frames. The cursor and camera are unaffected.
- Headless Chromium has no GPU, so heavy WebGL pages render slowly.
- The view doesn't list the hidden text boxes behind code editors and terminals. To type into one, click the editor first, then type with no target.

## License

MIT
