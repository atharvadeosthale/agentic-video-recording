#!/usr/bin/env node
import { Command } from "commander";
import { basename, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import { loadScenario } from "./load-scenario.js";
import { recordScenario, dryRunScenario } from "./runner/index.js";
import { exploreScenario } from "./runner/explore.js";
import { renderRecording } from "./compositor/render.js";
import { chromiumInfo, launchBrowser, connectToSession } from "./browser.js";
import {
  DEFAULT_SESSION_PORT,
  clearSession,
  readSession,
  sessionAlive,
  startSessionDaemon,
  waitForSession,
  ensureSession,
  sendCommand,
} from "./runner/session-store.js";
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

const sessionCmd = program
  .command("session")
  .description("Keep one logged-in browser alive so explore/find/act attach instead of relaunching");

sessionCmd
  .command("start")
  .description("Launch the session browser and log in once (spawns a detached daemon)")
  .option("--scenario <file>", "reuse this scenario's config and explore.setup for login")
  .option("--url <url>", "page to open after setup")
  .option("--port <n>", "CDP debug port (or AVR_SESSION_PORT)", String(process.env.AVR_SESSION_PORT || DEFAULT_SESSION_PORT))
  .option("--profile <dir>", "persistent Chromium user data dir", "/tmp/avr-session")
  .option("--headed", "show the browser window")
  .action(async (o) => {
    const existing = readSession();
    if (existing && (await sessionAlive(existing))) {
      console.log(JSON.stringify({ status: "already-running", ...existing }, null, 2));
      return;
    }
    const { pid } = startSessionDaemon({
      port: Number(o.port),
      userDataDir: resolve(o.profile),
      url: o.url,
      setup: o.scenario ? resolve(o.scenario) : undefined,
      config: { browser: { headless: !o.headed } },
      log,
    });
    const info = await waitForSession(pid);
    if (info.setupError) {
      console.log(JSON.stringify({ status: "started-but-login-failed", ...info }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ status: "started", ...info }, null, 2));
  });

sessionCmd
  .command("status")
  .description("Report whether a session is running and where it is")
  .action(async () => {
    const info = readSession();
    if (!info) return console.log(JSON.stringify({ status: "none" }, null, 2));
    const alive = await sessionAlive(info);
    console.log(JSON.stringify({ status: alive ? "running" : "stale", ...info }, null, 2));
  });

sessionCmd
  .command("stop")
  .description("Stop the session browser")
  .action(async () => {
    const info = readSession();
    if (!info) return console.log(JSON.stringify({ status: "none" }, null, 2));
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {}
    clearSession();
    console.log(JSON.stringify({ status: "stopped", pid: info.pid }, null, 2));
  });


/** Print a daemon reply; a failed step is a failed command. */
function printReply(reply: { ok: boolean; lines: string[] }) {
  console.log(reply.lines.filter(Boolean).join("\n"));
  if (!reply.ok) process.exitCode = 1;
}

/** What an exported scenario should import: the package, or this repo's source when run from inside it. */
function packageImport(fromFile: string): string {
  try {
    const here = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    if (here.name === pkg.name && existsSync(resolve("src/index.ts"))) {
      const rel = relative(dirname(resolve(fromFile)), resolve("src/index.js"));
      return rel.startsWith(".") ? rel : `./${rel}`;
    }
  } catch {}
  return pkg.name;
}

program
  .command("do")
  .description("Act in the live session and see what changed: goto, click, type, press, hover, scroll, scroll-to, wait-for, wait-url, wait, zoom, zoom-out")
  .argument("<verb>", "what to do")
  .argument("[args...]", 'the target in plain words ("new project"), then any text. Also role:name, text=…, css=…, or x,y')
  .option("--role <role>", "only consider elements with this ARIA role")
  .option("--nth <n>", "pick the n-th of several equally good matches")
  .option("--timeout <ms>", "for wait-for and wait-url", "30000")
  .option("--gone", "wait-for: wait until it disappears")
  .option("--scenario <file>", "when no session is running, start one using this scenario's login setup")
  .action(async (verb: string, args: string[], o) => {
    const isWait = verb === "wait-for" || verb === "wait-url";
    const info = await ensureSession({ scenario: o.scenario, log });
    printReply(
      await sendCommand(info, "/do", {
        verb, args, role: o.role, nth: o.nth ? Number(o.nth) : undefined, gone: o.gone,
        timeout: isWait ? Number(o.timeout) : undefined,
      }),
    );
  });

program
  .command("look")
  .description("Show the session's page: every element on screen numbered and grouped by region, plus a screenshot with the same numbers drawn on it")
  .option("--role <role>", "only this ARIA role")
  .option("--filter <text>", "only names containing this text")
  .option("--all", "also list what is scrolled off screen, not only its headings")
  .option("--scenario <file>", "when no session is running, start one using this scenario's login setup")
  .action(async (o) => {
    const info = await ensureSession({ scenario: o.scenario, log });
    printReply(await sendCommand(info, "/look", { role: o.role, filter: o.filter, all: o.all }));
  });

program
  .command("mark")
  .description('Name a beat in the journal. `avr mark setup`: unrecorded setup begins. `avr mark start`: the recording begins. Everything before either was looking around')
  .argument("<name>")
  .action(async (name: string) => {
    const info = await ensureSession({ log });
    printReply(await sendCommand(info, "/do", { verb: "mark", args: [name] }));
  });

/** "3 5-8" -> [3,5,6,7,8] */
function parseIds(parts: string[]): number[] {
  const ids: number[] = [];
  for (const part of parts.flatMap((p) => p.split(","))) {
    const m = /^#?(\d+)(?:-#?(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Not a step id or range: ${part}`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) ids.push(i);
  }
  return ids;
}

program
  .command("journal")
  .description("Show the steps taken with `avr do` and which of them will be exported. Detours are left out automatically")
  .argument("[action]", "drop | keep | setup | clear")
  .argument("[ids...]", "step ids or ranges, e.g. 5-8")
  .action(async (action: string | undefined, ids: string[]) => {
    if (action && !["drop", "keep", "setup", "clear"].includes(action)) throw new Error("Use: avr journal [drop|keep|setup <ids>] [clear]");
    const info = await ensureSession({ log });
    printReply(await sendCommand(info, "/journal", { action, ids: parseIds(ids) }));
  });

sessionCmd
  .command("export")
  .description("Write the kept journal steps as a scenario, after replaying them in a fresh tab to prove the path holds")
  .argument("<file>", "scenario file to write")
  .option("--name <name>", "scenario name")
  .option("--from <scenario>", "inherit config and login setup from this scenario (defaults to the one the session started with)")
  .option("--no-verify", "skip the replay")
  .option("--force", "overwrite the whole file, even if it was hand-written or its steps were edited")
  .action(async (file: string, o) => {
    const info = await ensureSession({ log });
    printReply(
      await sendCommand(info, "/export", {
        file: resolve(file), name: o.name ?? basename(file).replace(/\.[^.]+$/, ""), from: o.from ? resolve(o.from) : undefined,
        verify: o.verify, force: o.force, pkg: packageImport(file), budget: 180000,
      }),
    );
  });

program
  .command("find")
  .description("List elements matching a role and name on a page (no scenario needed)")
  .argument("<url>", "page to inspect; with --scenario, a path relative to the scenario's baseUrl")
  .requiredOption("--role <role>", "ARIA role, e.g. button, link, textbox, heading")
  .option("--name <text>", "accessible name; omit to list every element with that role")
  .option("--scenario <file>", "reuse a scenario's config, baseUrl and login setup before searching")
  .option("--base <url>", "base URL for relative navigation")
  .option("--wait-for <selector>", "wait for this selector before searching")
  .option("--settle <ms>", "extra settle time after load")
  .option("--within <selector>", "scope the search to a container")
  .option("--state <file>", "Playwright storage state file (cookies, localStorage, IndexedDB)")
  .option("--profile <dir>", "persistent Chromium user data dir")
  .option("--no-session", "ignore a running avr session and launch a fresh browser")
  .action(async (url: string, o) => {
    let config = resolveConfig(parseOverrides(o));
    let base = o.base ?? "";
    let setup: ((page: import("playwright").Page) => Promise<void>) | undefined;

    // Reusing a scenario is what makes this usable against a logged-in app: the scenario
    // already knows how to log in, so no storage state file is needed.
    if (o.scenario) {
      const scenario = await loadScenario(o.scenario);
      config = resolveConfig(scenario.config, parseOverrides(o));
      base = scenario.explore?.baseUrl ?? base;
      setup = scenario.explore?.setup;
    }

    const session = readSession();
    const useSession = !o.noSession && session && (await sessionAlive(session));
    // A live session already knows its origin, so a path needs no --base.
    if (!base && useSession && session?.url) {
      try {
        base = new URL(session.url).origin;
      } catch {}
    }

    const target = /^https?:/.test(url) ? url : `${base}${url}`;
    if (!/^https?:/.test(target)) {
      throw new Error("Pass --base <url>, --scenario <file> with a baseUrl, a full URL, or start a session with an --url.");
    }
    const launched = useSession
      ? await connectToSession(session!.port, config.browser)
      : await launchBrowser(config.browser, config.viewport, log);
    try {
      const page = launched.context.pages()[0] ?? (await launched.context.newPage());
      if (setup && !useSession) await setup(page);
      await page.goto(target, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      if (o.waitFor) await page.locator(o.waitFor).first().waitFor({ state: "visible" });
      if (o.settle) await page.waitForTimeout(Number(o.settle));
      const name = o.name ? new RegExp(o.name, "i") : undefined;
      const { findAllRoleTargets } = await import("./resolver.js");
      const matches = await findAllRoleTargets(page, { role: o.role, name, within: o.within } as any);
      // Matches without a box are not on screen; listing them as x:-1 only misleads.
      const visible = matches.filter((m) => m.width > 0 && m.height > 0);
      console.log(JSON.stringify({ url: page.url(), count: visible.length, hidden: matches.length - visible.length, matches: visible }, null, 2));
      if (!visible.length) process.exitCode = 1;
    } finally {
      await launched.close();
    }
  });

program
  .command("explore")
  .description("Visit pages once and inventory every clickable element into an index with @eNN handles")
  .argument("<target>", "a scenario file, or a URL/path to inventory")
  .option("-o, --out <dir>", "output directory")
  .option("--base <url>", "base URL prepended to relative paths")
  .option("--path <path...>", "extra paths to visit (repeatable)")
  .option("--wait-for <selector>", "wait for this selector on each page before inventorying")
  .option("--settle <ms>", "extra settle time per page")
  .option("--no-html", "skip the HTML inventory page")
  .option("--no-session", "ignore a running avr session and launch a fresh browser")
  .option("--list", "print the inventory to stdout as text instead of writing files")
  .action(async (target: string, o) => {
    const isScenario = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(target);
    const overrides = parseOverrides(o);
    let pages: { path: string; waitFor?: string; settle?: number }[];
    let baseUrl = o.base;
    let setup: ((page: import("playwright").Page) => Promise<void>) | undefined;

    if (isScenario) {
      const scenario = await loadScenario(target);
      const plan = scenario.explore;
      if (!plan) throw new Error(`${target} does not export an \`explore\` plan. Add one, or pass a URL to inventory directly.`);
      pages = plan.pages;
      baseUrl = baseUrl ?? plan.baseUrl;
      setup = plan.setup;
      overrides.name = undefined;
      for (const p of o.path ?? []) pages.push({ path: p, waitFor: o.waitFor, settle: o.settle ? Number(o.settle) : undefined });
    } else {
      if (!baseUrl) throw new Error("Pass --base <url> when inventorying a URL directly, or use a scenario file.");
      pages = [{ path: target, waitFor: o.waitFor, settle: o.settle ? Number(o.settle) : undefined }];
      for (const p of o.path ?? []) pages.push({ path: p, waitFor: o.waitFor, settle: o.settle ? Number(o.settle) : undefined });
    }

    const outDir = o.out ?? join("recordings", `explore-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
    const res = await exploreScenario({ pages, outDir, baseUrl, setup, config: overrides, log, html: o.html, noSession: o.session === false });

    if (o.list) {
      for (const page of res.bundle.pages) {
        console.log(`\n${page.url}`);
        for (const el of page.elements) {
          console.log(`  ${el.handle.padEnd(6)} ${el.role.padEnd(9)} ${JSON.stringify(el.name).slice(0, 70)}${el.disabled ? " (disabled)" : ""}`);
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          outDir: res.outDir,
          index: res.indexPath,
          pages: res.bundle.pages.map((p) => ({ url: p.url, elements: p.elements.length, ambiguous: p.ambiguous.length })),
          total: res.bundle.pages.reduce((n, p) => n + p.elements.length, 0),
          pagesSheet: res.sheets[0],
          html: res.html,
        },
        null,
        2,
      ),
    );
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
    .description("Run a scenario at recording pace without capturing or rendering, screenshotting every step into one contact sheet")
    .argument("<scenario>", "scenario .ts/.js file")
    .option("-o, --out <dir>", "output directory")
    .option("--scale <n>", "screenshot scale factor, e.g. 0.5")
    .option("--columns <n>", "contact sheet columns")
    .option("--fast", "skip pacing: instant typing, no waits. Quicker, but not the run the recording will be")
    .option("--no-contact-sheet", "keep individual screenshots only"),
).action(async (file: string, o) => {
  const scenario = await loadScenario(file);
  const overrides = parseOverrides(o);
  overrides.dryRun = { ...(overrides.dryRun ?? {}) };
  if (o.scale) overrides.dryRun.scale = Number(o.scale);
  if (o.columns) overrides.dryRun.columns = Number(o.columns);
  if (o.contactSheet === false) overrides.dryRun.contactSheet = false;
  const outDir = o.out ?? defaultOutDir(file, scenario.config.name);
  const res = await dryRunScenario(scenario, { outDir, config: overrides, log, fast: o.fast });
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

const GUIDE = `avr in one screen

THE LOOP (no scenario file, no selectors, no probe scripts)
  avr do goto http://localhost:3000/projects        # first command starts the browser
  avr do click 6                                    # a number from the view below
  avr do type 5 "acme-prod"
  avr do wait-for "Database ready" --timeout 120000 # slow server step
  avr do zoom 14                                    # camera only
  avr do zoom-out
  avr session export demo.ts              # replays the path to prove it, then writes it
  avr record demo.ts                      # -> output.mp4

  Logged-in app: add --scenario <file with explore.setup> to the FIRST command. It logs in once.

SEEING THE PAGE
  \`avr look\` and every \`avr do\` that lands on a new page or opens a dialog print the VIEW:
  every element on screen, numbered, grouped by region (header, nav, sidebar, main, dialog),
  with what the markup says it does:
      12 link "Auth" → /projects [current]
      31 button "More" [icon ellipsis] (opens menu)
      40 switch "Email alerts" [off]
  and the path of a screenshot with the same numbers drawn on it (view: /tmp/avr-view-…/007-step7.jpg).
  Open the screenshot when the text is not enough: icons, layout, what a chart shows.
  Off-screen content is summarised as its headings; \`scroll-to <n>\` or \`look --all\`.
  Other steps print only what changed: + new elements (with their numbers), - removed,
  ~ state changes, alerts, page errors (!). Numbers always refer to the latest view.

TARGETS
  12                       a number from the latest view (a control literally named "2": button:2)
  "new project"        plain words, best match wins; --nth 2 picks another; --role button narrows
  button:Create            role:name        text=Deployed     css=.monaco-editor     640,360
  The export never writes numbers: each becomes a role+name address that survives a replay.
  Several identical elements (three "Store" cards)? The error lists text that sets each apart.

EXPLORING VS RECORDING
  Click around freely. Steps that end up back where they started (open a menu, close it; visit
  a page, come back) are detours and are left out of the export automatically.
  avr mark setup           unrecorded setup begins (get the app into the state the video starts from)
  avr mark start           the recording begins; with no setup mark, everything before was looking around
  avr journal              where each step landed    avr journal drop 5-8 | keep 6 | setup 3 | clear

EXPORTING INTO AN EXISTING FILE
  Steps live between "// avr:steps-begin" and "// avr:steps-end". A re-export replaces only
  that block; config, helpers and login around it are kept. To add steps to a hand-written
  scenario (one with your login), put those two lines in its body and export into it.
  Setup steps use their own pair before startRecording(): "// avr:setup-begin" / "// avr:setup-end".
  Refused: no markers, hand-edited block, or --force on the file the session logged in from.
  avr dry-run paces the page exactly like avr record (pass there = pass in the recording); --fast does not.

WHEN SOMETHING FAILS
  The error shows the closest elements and what the page says (headings, alerts, text).
  "login page" or "not found" in that text means the wrong URL or no auth, not a wrong name.
  Nothing hangs: commands give up with a non-zero exit code. Do not wrap them in long timeouts.

MCP
  \`avr mcp\` serves all of this as MCP tools (avr_do, avr_look, avr_export, avr_dry_run, avr_record, …).
  Each reply carries the screenshot itself, so one call acts and shows the page.
  AVR_SESSION_PORT=9322 gives a second agent on the same machine its own browser.

THE LOOK (after the export works)
  Edit the exported file's config: viewport/deviceScaleFactor (capture), output (video size,
  fps), frame (padding, background, radius), cursor, zoom, keys. \`avr render <dir>\` restyles
  an existing capture without recording again. For a sharp 4K output, capture at dpr 3.
  Waits play in real time unless wrapped: s.lapse(8, () => ...) or s.trim(() => ...).
`;

program
  .command("mcp")
  .description("Run avr as a local MCP server over stdio. It launches Chrome itself; every step returns the numbered view and its screenshot")
  .action(async () => {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
  });

program
  .command("guide")
  .description("The whole agent workflow on one screen. Read this instead of the source")
  .action(() => console.log(GUIDE));

function progress(done: number, total: number) {
  process.stderr.write(`\r  frame ${done}/${total}`);
  if (done === total) process.stderr.write("\n");
}

// No discovery command may hang silently: a stuck page is a failure, reported as one.
const BUDGETS: Record<string, number> = { find: 60, explore: 120, look: 60 };
const budget = Number(process.env.AVR_BUDGET ?? BUDGETS[process.argv[2] ?? ""] ?? 0);
if (budget > 0) {
  setTimeout(() => {
    console.error(`avr ${process.argv[2]} gave up after ${budget}s: the page never became ready. Raise with AVR_BUDGET=<seconds> if the app is really that slow.`);
    process.exit(124);
  }, budget * 1000).unref();
}

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
