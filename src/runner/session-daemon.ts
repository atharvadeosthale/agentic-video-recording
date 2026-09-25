/**
 * The session daemon. Launches one Chromium with a fixed debugging port, optionally logs
 * in, then serves commands. `explore`/`find` attach over CDP; `avr do`, `look` and the
 * journal talk to the control port, because only a process that stays alive can diff the
 * page against its previous state and collect page errors between commands. Not meant to
 * be run directly; `avr session start` (or the first `avr do`) spawns it.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { resolveExecutablePath, ensureChromium, SAME_TAB_SCRIPT, NAME_HELPER_SCRIPT } from "../browser.js";
import { resolveConfig } from "../config.js";
import type { ScenarioConfig, UserScenarioConfig } from "../types.js";
import { writeSession, daemonBuild } from "./session-store.js";
import { Session } from "./session.js";
import { observe, diffObservations, formatObservation, formatGist, fmtLabeled, pathOf, type Observation } from "../observe.js";
import type { InventoryElement } from "../inventory.js";
import { ViewWriter } from "./view.js";
import {
  addressFor,
  coveredBy,
  exportScenario,
  replaceStepsBlock,
  stepsBlock,
  formatJournal,
  isCameraStep,
  keptEntries,
  markDetours,
  nearest,
  parseExplicit,
  pickElement,
  runStep,
  stepToCode,
  type JournalEntry,
  type PlainTarget,
  type Step,
} from "./live.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(arg("port") ?? 9222);
const controlPort = port + 1;
const userDataDir = arg("user-data-dir") ?? "/tmp/avr-session";
const sessionPath = arg("session")!;
const setupFile = arg("setup");
const startUrl = arg("url");
const cfg: ScenarioConfig = resolveConfig(JSON.parse(arg("config") ?? "{}") as UserScenarioConfig);
const stateDir = dirname(sessionPath);
const journalPath = join(stateDir, "journal.json");

ensureChromium(cfg.browser);

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: cfg.browser.headless,
  executablePath: resolveExecutablePath(cfg.browser),
  viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
  deviceScaleFactor: cfg.viewport.deviceScaleFactor,
  locale: cfg.browser.locale,
  timezoneId: cfg.browser.timezoneId,
  colorScheme: cfg.browser.colorScheme,
  ignoreHTTPSErrors: true,
  args: [
    `--remote-debugging-port=${port}`,
    "--hide-scrollbars",
    "--disable-smooth-scrolling",
    ...(cfg.browser.args ?? []),
  ],
});

context.setDefaultTimeout(cfg.browser.timeout);
await context.addInitScript(NAME_HELPER_SCRIPT);
if (cfg.browser.sameTabLinks) await context.addInitScript(SAME_TAB_SCRIPT);
const page = context.pages()[0] ?? (await context.newPage());

// ---------------------------------------------------------------------------
// Page health: what went wrong on the page since the last command
// ---------------------------------------------------------------------------

let problems: string[] = [];
let crashed = false;
function watch(p: Page) {
  p.on("pageerror", (e) => problems.push(`pageerror: ${e.message.split("\n")[0]}`));
  p.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text().split("\n")[0].slice(0, 200)}`);
  });
  p.on("response", (r) => {
    const type = r.request().resourceType();
    if (r.status() >= 400 && (type === "document" || type === "xhr" || type === "fetch")) problems.push(`HTTP ${r.status()} ${r.request().method()} ${pathOf(r.url())}`);
  });
  p.on("requestfailed", (r) => {
    if (r.resourceType() === "document") problems.push(`request failed: ${pathOf(r.url())} ${r.failure()?.errorText ?? ""}`);
  });
  p.on("crash", () => {
    crashed = true;
    problems.push("the page crashed (renderer died). Restart the session.");
  });
}
watch(page);

function drainProblems(): string[] {
  const counts = new Map<string, number>();
  for (const p of problems) counts.set(p, (counts.get(p) ?? 0) + 1);
  problems = [];
  const lines = [...counts].slice(0, 6).map(([p, n]) => `! ${p}${n > 1 ? ` (x${n})` : ""}`);
  if (counts.size > 6) lines.push(`! … ${counts.size - 6} more page problems`);
  return lines;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

let journal: JournalEntry[] = [];
if (existsSync(journalPath)) renameSync(journalPath, join(stateDir, "journal.prev.json"));
const saveJournal = () => {
  markDetours(journal);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
};

const build = daemonBuild();
const publish = (extra: Record<string, unknown> = {}) =>
  writeSession(
    {
      pid: process.pid, port, controlPort, cdpUrl: `http://127.0.0.1:${port}`, userDataDir,
      startedAt: new Date().toISOString(), scenario: setupFile, url: page.url(), build, ...extra,
    },
    sessionPath,
  );

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const started = Date.now();
const views = new ViewWriter(port);
/** The last view the agent was shown. Its numbers are what `avr do click 12` means. */
let lastView: Observation | null = null;

/** Write the view for an observation and make its numbers the current ones. */
async function showView(obs: Observation, name: string): Promise<string | undefined> {
  lastView = obs;
  return views.write(context, page, obs, name).catch(() => undefined);
}

/** The view's path, and the page size it shows, so a scaled image is not mistaken for the viewport. */
function viewLine(file: string): string {
  const vp = page.viewportSize();
  return `view: ${file}${vp ? ` (the ${vp.width}x${vp.height} page, scaled down)` : ""}`;
}

/**
 * The element a number from the last view refers to. When the page has changed since, the
 * same element is found again by what it is and where it was.
 */
function byNumber(obs: Observation, n: number, notes: string[]): InventoryElement {
  if (!lastView) throw new Error(`There is no view yet for number ${n} to refer to. Run \`avr look\` first.`);
  const was = lastView.elements.find((e) => e.label === n);
  if (!was) throw new Error(`The last view has no number ${n} (it runs 1-${lastView.elements.length}). Run \`avr look\` for the current numbers.`);
  if (obs.fingerprint === lastView.fingerprint) return obs.elements.find((e) => e.label === n) ?? was;
  const same = obs.elements
    .filter((e) => e.role === was.role && e.name === was.name)
    .sort((a, b) => Math.hypot(a.x - was.x, a.y - was.y) - Math.hypot(b.x - was.x, b.y - was.y));
  if (!same.length) throw new Error(`${n} was ${fmtLabeled(was, { number: false })} in the last view, and it is not on the page now. Run \`avr look\` for the current numbers.`);
  notes.push(`the page changed since the last view; found ${n} again by its name`);
  return same[0];
}
const live = new Session(page, cfg, () => Date.now() - started, { dry: true, fast: true });

/** Wait for the page to stop changing after an action, without guessing a fixed sleep. */
async function settle(maxMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  await page.waitForLoadState("domcontentloaded", { timeout: maxMs }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(2500, maxMs) }).catch(() => {});
  let prev = "";
  let same = 0;
  while (Date.now() < deadline) {
    const fp = await observe(page).then((o) => o.fingerprint).catch(() => "");
    if (fp && fp === prev) {
      if (++same >= 2) return true;
    } else same = 0;
    prev = fp;
    await page.waitForTimeout(200);
  }
  return false;
}

interface Reply {
  ok: boolean;
  lines: string[];
  /** The numbered screenshot for this reply, when there is one. */
  view?: string;
}

interface DoRequest {
  verb: string;
  args: string[];
  role?: string;
  nth?: number;
  timeout?: number;
  gone?: boolean;
}

async function resolveQuery(obs: Observation, query: string, verb: Step["verb"], req: DoRequest, notes: string[]): Promise<PlainTarget> {
  // A bare number is a label from the last view.
  if (/^\d+$/.test(query.trim())) {
    const el = byNumber(obs, Number(query), notes);
    const target = await addressFor(page, el);
    notes.unshift(`matched ${fmtLabeled(el)}`);
    if (el.disabled) notes.push("warning: this element is disabled");
    if (verb === "click" && el.covered) notes.push(`note: ${el.covered} sits on top of it and receives the click`);
    return target;
  }
  const explicit = parseExplicit(query);
  if (explicit.target) return explicit.target;
  const pick = pickElement(obs, explicit.phrase, verb, { role: req.role ?? explicit.role, nth: req.nth });
  if (!pick) {
    const near = nearest(obs, explicit.phrase);
    throw new Error(
      [
        `Nothing on the page matches ${JSON.stringify(query)}${req.role ?? explicit.role ? ` with role ${req.role ?? explicit.role}` : ""}.`,
        ...(near.length ? ["  Closest:", ...near.map((e) => `    ${e.role} ${JSON.stringify(e.name.slice(0, 56))}`)] : []),
        formatGist(obs.url, obs),
        "  `avr look` lists everything on the page.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const target = await addressFor(page, pick.el);
  notes.push(`matched ${pick.el.role} ${JSON.stringify(pick.el.name.slice(0, 56))} at ${pick.el.x + Math.round(pick.el.width / 2)},${pick.el.y + Math.round(pick.el.height / 2)}`);
  if (typeof target === "object" && "near" in target && target.near)
    notes.push(`several elements share this name; addressed by the text next to it (${JSON.stringify(target.near)}), which holds even if their order changes`);
  if (pick.alternatives.length)
    notes.push(`also matching (pick with --nth): ${pick.alternatives.slice(0, 4).map((e, i) => `${i + 2}: ${e.role} ${JSON.stringify(e.name.slice(0, 36))}`).join("  ")}`);
  if (pick.el.disabled) notes.push("warning: this element is disabled");
  if (verb === "click") {
    const cover = await coveredBy(page, pick.el);
    if (cover) notes.push(`note: ${cover} sits on top of it and receives the click, as it would for a person`);
  }
  return target;
}

async function buildStep(req: DoRequest, obs: Observation, notes: string[]): Promise<Step> {
  const [a, b] = req.args;
  const need = (v: string | undefined, what: string) => {
    if (v === undefined || v === "") throw new Error(`avr do ${req.verb} needs ${what}.`);
    return v;
  };
  switch (req.verb) {
    case "goto": {
      const url = need(a, "a URL or path");
      if (/^https?:/.test(url)) return { verb: "goto", url };
      if (!/^https?:/.test(page.url())) throw new Error("Pass a full URL: the session is not on a page yet.");
      return { verb: "goto", url: new URL(url, page.url()).href };
    }
    case "click":
    case "hover":
    case "zoom":
      return { verb: req.verb, target: await resolveQuery(obs, need(a, "a target"), req.verb, req, notes) };
    case "scroll-to":
      return { verb: "scrollTo", target: await resolveQuery(obs, need(a, "a target"), "scrollTo", req, notes) };
    case "type":
      if (b === undefined) return { verb: "type", target: null, text: need(a, "text") };
      return { verb: "type", target: await resolveQuery(obs, a, "type", req, notes), text: b };
    case "press":
      return { verb: "press", key: need(a, "a key, e.g. Enter or Control+K") };
    case "scroll":
      return { verb: "scroll", dy: Number(need(a, "a pixel delta, e.g. 600")) };
    case "wait":
      return { verb: "wait", ms: Number(need(a, "milliseconds")) };
    case "zoom-out":
      return { verb: "zoomOut" };
    case "mark":
      return { verb: "mark", name: need(a, "a name") };
    case "wait-url":
      return { verb: "waitUrl", pattern: need(a, "a URL pattern (regular expression)"), timeout: req.timeout };
    case "wait-for": {
      // The thing being waited for is usually not on the page yet, so it cannot be picked
      // from the current elements. Treat a bare phrase as visible text.
      const q = need(a, "text or a target");
      const explicit = parseExplicit(q);
      const target: PlainTarget = explicit.target ?? (explicit.role ? { role: explicit.role, name: explicit.phrase, exact: false } : { text: q, exact: false });
      return { verb: "waitFor", target, gone: req.gone, timeout: req.timeout };
    }
    default:
      throw new Error(`Unknown verb "${req.verb}". Verbs: goto click type press hover scroll scroll-to wait-for wait-url wait zoom zoom-out mark.`);
  }
}

async function doCommand(req: DoRequest): Promise<Reply> {
  if (crashed) return { ok: false, lines: ["The page crashed earlier. Run `avr session stop` and start again."] };
  const notes: string[] = [];
  const before = await observe(page);
  const step = await buildStep(req, before, notes);
  const code = stepToCode(step);
  const entry: JournalEntry = {
    id: (journal.at(-1)?.id ?? 0) + 1, step, code,
    urlBefore: before.url, urlAfter: before.url, stateBefore: before.fingerprint, stateAfter: before.fingerprint, ok: false,
  };

  let failure: string | undefined;
  const t0 = Date.now();
  try {
    await runStep(live, step);
  } catch (e) {
    failure = (e as Error).message;
  }
  const camera = isCameraStep(step);
  let settled = camera ? true : await settle();
  let after = await observe(page);
  // A click or key whose effect is late (a slow client-side navigation) looks like nothing
  // happened. Give it a moment before saying so.
  if (!failure && (step.verb === "click" || step.verb === "press") && after.fingerprint === before.fingerprint) {
    const until = Date.now() + 3000;
    while (Date.now() < until && after.fingerprint === before.fingerprint) {
      await page.waitForTimeout(250);
      after = await observe(page);
    }
    if (after.fingerprint !== before.fingerprint) {
      settled = await settle();
      after = await observe(page);
    }
  }
  entry.ok = !failure;
  entry.urlAfter = after.url;
  entry.stateAfter = after.fingerprint;
  journal.push(entry);
  saveJournal();
  publish();

  const lines: string[] = [];
  lines.push(`${failure ? "✗" : "✓"} #${entry.id} ${code}`);
  for (const n of notes) lines.push(`  ${n}`);
  if (failure) lines.push(...failure.split("\n").map((l) => `  ${l}`));
  let view: string | undefined;
  if (!camera) {
    const waited = step.verb === "waitFor" || step.verb === "waitUrl";
    if (waited && !failure) lines.push(`met after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const newPage = before.url.split(/[?#]/)[0] !== after.url.split(/[?#]/)[0];
    const dialogOpened = !!after.dialog && after.dialog.name !== before.dialog?.name;
    if (newPage || dialogOpened) {
      // A new page or a dialog is a new view: show all of it, numbered, instead of a diff.
      if (newPage) lines.push(`url: ${pathOf(before.url)} -> ${pathOf(after.url)}`);
      lines.push(...formatObservation(after));
    } else {
      const diff = diffObservations(before, after);
      if (diff.length) lines.push(...diff);
      else if (!failure && !waited) lines.push(step.verb === "click" || step.verb === "press" ? "no visible change: the page is in the same state as before (wrong element, or nothing to do?)" : "no visible change");
    }
    if (!settled) lines.push("the page was still changing after 5s; `avr look` again, or `avr do wait-for <text>`");
    view = await showView(after, `step${entry.id}`);
    if (view) lines.push(viewLine(view));
  }
  if (entry.detour && !failure && !camera && journal.length > 1) lines.push("(journal: back at an earlier state, so the steps since then are marked as a detour)");
  lines.push(...drainProblems());
  return { ok: !failure, lines, view };
}

async function lookCommand(req: { role?: string; filter?: string; all?: boolean }): Promise<Reply> {
  const obs = await observe(page);
  const view = await showView(obs, "look");
  return { ok: true, lines: [...formatObservation(obs, req), ...(view ? [viewLine(view)] : []), ...drainProblems()], view };
}

async function journalCommand(req: { action?: "drop" | "keep" | "setup" | "clear"; ids?: number[] }): Promise<Reply> {
  if (req.action === "clear") journal = [];
  else if (req.action) {
    const ids = new Set(req.ids ?? []);
    const missing = [...ids].filter((id) => !journal.some((e) => e.id === id));
    if (missing.length) return { ok: false, lines: [`No journal step ${missing.map((m) => `#${m}`).join(", ")}.`] };
    for (const e of journal) {
      if (!ids.has(e.id)) continue;
      e.keep = req.action === "keep";
      e.drop = req.action === "drop";
      e.setup = req.action === "setup";
    }
  }
  saveJournal();
  const lines = formatJournal(journal);
  return { ok: true, lines: lines.length ? lines : ["The journal is empty. Steps taken with `avr do` land here."] };
}

/** Replay the kept steps in a fresh tab of the same logged-in browser. */
async function verify(startAt: string, entries: JournalEntry[]): Promise<string[]> {
  const tab = await context.newPage();
  watch(tab);
  const t0 = Date.now();
  const s = new Session(tab, cfg, () => Date.now() - t0, { dry: true, fast: true });
  try {
    await tab.goto(startAt, { waitUntil: "domcontentloaded" });
    await s.ready();
    for (const e of entries) {
      const urlWas = tab.url();
      try {
        await runStep(s, e.step);
      } catch (err) {
        const g = await observe(tab).catch(() => null);
        return [
          `✗ verify failed at #${e.id} ${e.code}`,
          ...(err as Error).message.split("\n").map((l) => `  ${l}`),
          ...(g ? [formatGist(g.url, g)] : []),
          "  A kept step probably depends on a dropped one (`avr journal keep <id>`), or the rehearsal changed server state (a name now taken, an item already created).",
        ];
      }
      if (!isCameraStep(e.step)) {
        if (tab.url() !== urlWas) await s.ready().catch(() => {});
        else await tab.waitForTimeout(250);
      }
    }
    return [`✓ verified: ${entries.length} steps replay cleanly from ${pathOf(startAt)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`];
  } finally {
    await tab.close().catch(() => {});
  }
}

async function exportCommand(req: { file: string; name?: string; from?: string; verify?: boolean; force?: boolean; pkg: string }): Promise<Reply> {
  saveJournal();
  const kept = keptEntries(journal);
  if (!kept.record.some((e) => !isCameraStep(e.step))) return { ok: false, lines: ["Nothing to export: no recorded steps. `avr journal` shows where each step landed."] };
  const all = [...kept.setup, ...kept.record];
  const first = all.find((e) => !isCameraStep(e.step))!;
  // A leading goto is the start URL itself.
  const startAt = first.step.verb === "goto" ? first.step.url : first.urlBefore;
  const setupSteps = kept.setup.filter((e) => e !== first || first.step.verb !== "goto");
  const body = kept.record.filter((e) => e !== first || first.step.verb !== "goto");
  const lines: string[] = [];
  let ok = true;
  if (req.verify !== false) {
    const v = await verify(startAt, [...setupSteps, ...body]);
    ok = v[0].startsWith("✓");
    lines.push(...v);
  }
  const file = resolve(req.file);
  const from = req.from ?? setupFile;
  let importFrom: string | undefined;
  let hasSetup = false;
  if (from && existsSync(from)) {
    const rel = relative(dirname(file), resolve(from));
    importFrom = (rel.startsWith(".") ? rel : `./${rel}`).replace(/\.ts$/, ".js");
    hasSetup = /setup\s*:/.test(readFileSync(from, "utf8"));
  }
  if (req.force && from && resolve(from) === file)
    return { ok: false, lines: [...lines, `✗ ${relative(process.cwd(), file)} holds the login this session uses; --force would delete it. Add the two steps markers to it instead, or export to a new file.`] };
  const block = stepsBlock(setupSteps.at(-1)?.urlAfter ?? startAt, body);
  const setupBlock = setupSteps.length ? stepsBlock(startAt, setupSteps, "setup") : undefined;
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  let updated = false;
  let out: string;
  if (existing.trim() && !req.force) {
    // Look before overwriting: only the steps block is ours to replace.
    const merged = replaceStepsBlock(existing, block);
    if (!merged.source) {
      return {
        ok: false,
        lines: [
          ...lines,
          `✗ Did not write ${relative(process.cwd(), file)}: ${merged.refused}.`,
          "  Export to a new file name, or pass --force to overwrite the whole file.",
        ],
      };
    }
    out = merged.source;
    if (setupBlock) {
      const withSetup = replaceStepsBlock(out, setupBlock, "setup");
      if (!withSetup.source)
        return { ok: false, lines: [...lines, `✗ Did not write ${relative(process.cwd(), file)}: ${withSetup.refused}.`] };
      out = withSetup.source;
    }
    updated = true;
    if (!existing.includes(JSON.stringify(startAt))) lines.push(`note: the path now starts at ${pathOf(startAt)}, but the file's own goto was left as it is. Check it.`);
  } else {
    out = exportScenario({ name: req.name ?? "recording", startUrl: startAt, block, setupBlock, importFrom, hasSetup, pkg: req.pkg, viewport: cfg.viewport });
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, out);
  lines.push(`${updated ? "Updated the steps block in" : ok ? "Wrote" : "Wrote (unverified path)"} ${relative(process.cwd(), file)}: ${setupSteps.length ? `${setupSteps.length} setup + ` : ""}${body.length} recorded steps from ${pathOf(startAt)}`);
  lines.push(`Next: avr record ${relative(process.cwd(), file)}`);
  return { ok, lines };
}

// One command at a time: they share a page.
let queue: Promise<unknown> = Promise.resolve();
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const run = async (): Promise<Reply> => {
      const body = raw ? JSON.parse(raw) : {};
      const budget = (body.timeout ?? 0) + (body.budget ?? 45000);
      let timer: NodeJS.Timeout;
      const work =
        req.url === "/do" ? doCommand(body)
        : req.url === "/look" ? lookCommand(body)
        : req.url === "/journal" ? journalCommand(body)
        : req.url === "/export" ? exportCommand(body)
        : Promise.resolve({ ok: false, lines: [`unknown command ${req.url}`] });
      const over = new Promise<Reply>((r) => {
        timer = setTimeout(
          () => r({ ok: false, lines: [`✗ gave up after ${Math.round(budget / 1000)}s: the page is not responding (now at ${pathOf(page.url())}).`, ...drainProblems()] }),
          budget,
        );
      });
      return Promise.race([work, over]).finally(() => clearTimeout(timer));
    };
    const p = queue.then(run, run).catch((e): Reply => ({ ok: false, lines: [`✗ ${(e as Error).message}`, ...drainProblems()] }));
    queue = p;
    p.then((reply) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
});
server.listen(controlPort, "127.0.0.1");

publish({ url: undefined, ready: false });

let setupError: string | undefined;
try {
  if (setupFile) {
    const { loadSetup } = await import("./session-store.js");
    const setup = await loadSetup(setupFile);
    await setup(page);
  }
  if (startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  process.stdout.write(`session ready on ${page.url()}\n`);
} catch (e) {
  setupError = (e as Error).message.split("\n")[0];
  process.stderr.write(`session setup failed: ${setupError}\n`);
}
publish({ ready: true, setupError });

// Stay alive until asked to stop.
const shutdown = async () => {
  server.close();
  views.cleanup();
  await context.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1 << 30);
