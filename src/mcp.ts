/**
 * `takeone mcp`: a local MCP server over stdio. It launches Chrome itself (through the same
 * session process the CLI uses), so an agent can rehearse, export, dry-run and record a
 * scenario without touching the shell. Every step replies with the numbered outline and the
 * screenshot the numbers are drawn on, in one tool result: act and see in a single call.
 *
 * The protocol is newline-delimited JSON-RPC 2.0, small enough to speak directly.
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, basename, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { clearSession, ensureSession, readSession, sendCommand, sessionAlive, type CommandReply, type SessionInfo } from "./runner/session-store.js";
import type { UserScenarioConfig } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "cli.js");

// stdout is the protocol channel. Anything else goes to stderr.
const log = (s: string) => process.stderr.write(`${s}\n`);

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  isError?: boolean;
}

const INSTRUCTIONS = `takeone records Screen Studio style videos of web apps. You rehearse in a live browser; the rehearsal becomes the scenario; the scenario is recorded on its own clock, so your latency never shows in the video.

LOOP
1. takeone_do {verb:"goto", target:"<url>"} starts Chrome on the first call. For a logged-in app call takeone_start {scenario:"<file with explore.setup>"} first; it logs in once.
2. Every takeone_do and takeone_look reply shows the page: every element on screen numbered and grouped by region (header, nav, sidebar, main, dialog), with what the markup says it does (→ link destination, "opens menu", [on]/[selected]/[= value], [icon trash-2]), plus a screenshot with the same numbers drawn on it. Look once, then act by number: takeone_do {verb:"click", target:"12"}.
3. After a step the reply shows what changed: + new elements (numbered), - removed, ~ state changes, alerts, dialogs, page errors (!). A new page or dialog shows the whole numbered view again.
4. takeone_mark {name:"start"} where the video begins (and optionally {name:"setup"} before it for unrecorded preparation). Steps that return to an earlier state are left out automatically as detours; takeone_journal shows and overrides that.
5. takeone_export {file:"demo.ts"} replays the kept steps to prove them, then writes the scenario. Numbers are never written: each becomes a role+name address.
6. takeone_dry_run {file} paces the scenario exactly like the recording and returns a contact sheet. takeone_record {file} captures and renders the video.

TARGETS: a number from the last view ("12"), plain words ("new project"), role:name ("button:Create"), text=..., css=..., or "x,y". A control literally named with digits: "button:2".
Zooms are camera moves only: takeone_do {verb:"zoom", target:"7"} / {verb:"zoom-out"}.
Nothing hangs: every call gives up with an error instead.`;

const TARGET_HELP = 'What to act on. A number from the last view ("12"), plain words ("new project"), role:name ("button:Create"), text=…, css=…, or "x,y". For goto: the URL. press: the key ("Enter", "Control+K"). scroll: pixels ("600"). wait: milliseconds. wait-for: text to wait for. wait-url: a URL regex.';

const TOOLS = [
  {
    name: "takeone_start",
    description: "Start (or restart) the browser session. Optional: takeone_do starts one on its own. Use it to log in through a scenario's explore.setup, to open a start URL, or to watch the browser (headed).",
    inputSchema: {
      type: "object",
      properties: {
        scenario: { type: "string", description: "Scenario file whose config and explore.setup (login) the session should use" },
        url: { type: "string", description: "Page to open once the session is up" },
        headed: { type: "boolean", description: "Show the browser window (needs a display)" },
        viewport: { type: "string", description: "Browser size, e.g. 1920x1080" },
      },
    },
  },
  {
    name: "takeone_look",
    description: "Show the current page: every on-screen element numbered and grouped by region, what each does, and a screenshot with the same numbers. Off-screen content is summarised as its headings.",
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Only elements whose name contains this text (searches off-screen too)" },
        role: { type: "string", description: "Only this ARIA role" },
        all: { type: "boolean", description: "List off-screen elements too" },
        screenshot: { type: "boolean", description: "Include the numbered screenshot (default true)" },
      },
    },
  },
  {
    name: "takeone_do",
    description: "Take one step in the live browser, journal it as a scenario line, and see the result: what changed, and the numbered view with its screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        verb: { type: "string", enum: ["goto", "click", "type", "press", "hover", "scroll", "scroll-to", "wait-for", "wait-url", "wait", "zoom", "zoom-out"] },
        target: { type: "string", description: TARGET_HELP },
        text: { type: "string", description: "type: the text to type. Omit target to type into the focused element." },
        nth: { type: "number", description: "Pick the n-th of several equally good plain-word matches" },
        role: { type: "string", description: "Only consider elements with this ARIA role" },
        timeout: { type: "number", description: "wait-for / wait-url: milliseconds to wait (default 30000)" },
        gone: { type: "boolean", description: "wait-for: wait until the text disappears" },
        screenshot: { type: "boolean", description: "Include the numbered screenshot (default true)" },
      },
      required: ["verb"],
    },
  },
  {
    name: "takeone_mark",
    description: 'Mark a point in the journal. "start": the recording begins here; steps before it were looking around. "setup": unrecorded preparation begins (before "start"). Any other name is a labelled beat.',
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "takeone_journal",
    description: "Show every step taken and where it lands in the export (explore, setup, record, detour, drop, failed), or override: drop/keep/setup step ids, or clear.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["drop", "keep", "setup", "clear"] },
        ids: { type: "array", items: { type: "number" }, description: "Step ids (the #N in each step's first line)" },
      },
    },
  },
  {
    name: "takeone_export",
    description: "Replay the kept steps in a fresh tab to prove the path, then write them as a scenario file. Into an existing file, only the marked steps block is replaced.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Scenario file to write, e.g. demo.ts" },
        name: { type: "string", description: "Scenario name (defaults to the file name)" },
        from: { type: "string", description: "Inherit config and login from this scenario (defaults to the one the session started with)" },
        verify: { type: "boolean", description: "Replay before writing (default true)" },
        force: { type: "boolean", description: "Overwrite the whole file" },
      },
      required: ["file"],
    },
  },
  {
    name: "takeone_dry_run",
    description: "Run a scenario at recording pace without capturing, and return the contact sheet of every step. A dry run that passes is a recording that will pass.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        fast: { type: "boolean", description: "Skip pacing. Quicker, but not the run the recording will be" },
        scale: { type: "number", description: "Screenshot scale for the sheet, e.g. 0.35 (cheaper to look at)" },
      },
      required: ["file"],
    },
  },
  {
    name: "takeone_record",
    description: "Record a scenario and render the video. Returns the video path and a keyframe sheet. Takes as long as the scenario plus rendering.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        render: { type: "boolean", description: "Render after capture (default true). false: capture only, render later with `takeone render`" },
      },
      required: ["file"],
    },
  },
  {
    name: "takeone_stop",
    description: "Close the browser session.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/** Sessions this server started, so it can close them when the client goes away. */
let startedPid: number | undefined;

async function session(opts: { scenario?: string; url?: string; config?: UserScenarioConfig } = {}): Promise<SessionInfo> {
  const before = readSession();
  const info = await ensureSession({ ...opts, log });
  if (info.pid !== before?.pid) startedPid = info.pid;
  return info;
}

async function stopSession(): Promise<boolean> {
  const info = readSession();
  if (!info) return false;
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {}
  clearSession();
  if (info.pid === startedPid) startedPid = undefined;
  return true;
}

function image(file: string | undefined): Content[] {
  if (!file || !existsSync(file)) return [];
  return [{ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/jpeg" }];
}

/** A daemon reply as tool content: the text, then the numbered screenshot. */
function reply(r: CommandReply, withShot = true): ToolResult {
  // The image travels in the reply, so its path is noise; the page size it shows is not.
  const lines = withShot ? r.lines.map((l) => (l.startsWith("view: ") ? l.replace(/^view: \S+ \(/, "screenshot below (") : l)) : r.lines;
  return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }, ...(withShot ? image(r.view) : [])], isError: !r.ok };
}

/** Run the CLI for the long jobs (dry-run, record) and read the JSON it prints last. */
function runCli(args: string[]): Promise<{ code: number; json?: Record<string, unknown>; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let json: Record<string, unknown> | undefined;
      const start = out.lastIndexOf("\n{") >= 0 ? out.lastIndexOf("\n{") + 1 : out.indexOf("{");
      try {
        if (start >= 0) json = JSON.parse(out.slice(start));
      } catch {}
      // Progress lines rewrite themselves with \r; keep only what each line ended as.
      done({ code: code ?? 1, json, stderr: err.split("\n").map((l) => l.split("\r").pop()).join("\n") });
    });
  });
}

const tail = (s: string, n = 30) => s.trim().split("\n").slice(-n).join("\n");

async function call(name: string, a: Record<string, any>): Promise<ToolResult> {
  const shot = a.screenshot !== false;
  switch (name) {
    case "takeone_start": {
      await stopSession();
      const config: UserScenarioConfig = {};
      if (a.headed) config.browser = { headless: false };
      if (a.viewport) {
        const [width, height] = String(a.viewport).split("x").map(Number);
        config.viewport = { width, height };
      }
      const info = await session({ scenario: a.scenario ? resolve(a.scenario) : undefined, url: a.url, config });
      const r = (await sendCommand(info, "/look", {}));
      const head = `Session started${a.scenario ? ` (logged in via ${a.scenario})` : ""}${info.setupError ? `. Login setup FAILED: ${info.setupError}` : ""}.`;
      const out = reply(r, shot);
      out.content[0] = { type: "text", text: `${head}\n${(out.content[0] as { text: string }).text}` };
      if (info.setupError) out.isError = true;
      return out;
    }
    case "takeone_look": {
      const info = await session();
      return reply((await sendCommand(info, "/look", { filter: a.filter, role: a.role, all: a.all })), shot);
    }
    case "takeone_do": {
      const verb = String(a.verb);
      const args: string[] = [];
      if (a.target !== undefined && a.target !== null && a.target !== "") args.push(String(a.target));
      if (verb === "type") {
        if (a.text === undefined) return { content: [{ type: "text", text: "type needs text." }], isError: true };
        args.push(String(a.text));
      }
      const isWait = verb === "wait-for" || verb === "wait-url";
      const info = await session();
      const r = await sendCommand(info, "/do", {
        verb, args, role: a.role, nth: a.nth, gone: a.gone,
        timeout: isWait ? Number(a.timeout ?? 30000) : undefined,
      });
      return reply(r, shot);
    }
    case "takeone_mark": {
      const info = await session();
      return reply(await sendCommand(info, "/do", { verb: "mark", args: [String(a.name)] }), false);
    }
    case "takeone_journal": {
      const info = await session();
      return reply(await sendCommand(info, "/journal", { action: a.action, ids: a.ids ?? [] }), false);
    }
    case "takeone_export": {
      const info = await session();
      const file = resolve(String(a.file));
      const r = await sendCommand(info, "/export", {
        file, name: a.name ?? basename(file).replace(/\.[^.]+$/, ""), from: a.from ? resolve(a.from) : undefined,
        verify: a.verify, force: a.force, pkg: packageImport(file), budget: 180000,
      });
      // The CLI's next-step hint, in tool terms.
      r.lines = r.lines.map((l) => (l.startsWith("Next: takeone record") ? `Next: takeone_dry_run {file: ${JSON.stringify(a.file)}}, then takeone_record.` : l));
      return reply(r, false);
    }
    case "takeone_dry_run": {
      const args = ["dry-run", resolve(String(a.file))];
      if (a.fast) args.push("--fast");
      if (a.scale) args.push("--scale", String(a.scale));
      const r = await runCli(args);
      const sheet = r.json?.contactSheet as string | undefined;
      const text = r.json
        ? `${r.json.error ? `✗ failed: ${r.json.error}` : `✓ ${r.json.steps} steps ran`}\n${tail(r.stderr, 40)}\ncontact sheet: ${sheet ?? "none"}`
        : `✗ dry-run did not finish (exit ${r.code})\n${tail(r.stderr, 40)}`;
      return { content: [{ type: "text", text }, ...image(sheet)], isError: r.code !== 0 };
    }
    case "takeone_record": {
      const args = ["record", resolve(String(a.file))];
      if (a.render === false) args.push("--no-render");
      const r = await runCli(args);
      const keyframes = r.json?.keyframes as string | undefined;
      const text = r.json ? `${JSON.stringify(r.json, null, 2)}\n${tail(r.stderr, 12)}` : `✗ record did not finish (exit ${r.code})\n${tail(r.stderr, 40)}`;
      return { content: [{ type: "text", text }, ...image(keyframes)], isError: r.code !== 0 };
    }
    case "takeone_stop":
      return { content: [{ type: "text", text: (await stopSession()) ? "Session stopped." : "No session was running." }] };
    default:
      return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
  }
}

/** What an exported scenario should import: the package, or this repo's source when run from inside it. */
function packageImport(fromFile: string): string {
  try {
    const cwdPkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    if (cwdPkg.name === pkg.name && existsSync(resolve("src/index.ts"))) {
      const rel = relative(dirname(resolve(fromFile)), resolve("src/index.js"));
      return rel.startsWith(".") ? rel : `./${rel}`;
    }
  } catch {}
  return pkg.name;
}

export async function runMcpServer(): Promise<void> {
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; params?: any };
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    // Notifications (initialized, cancelled) need no answer.
    if (msg.id === undefined || msg.id === null) return;
    const ok = (result: unknown) => send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "takeone", version: pkg.version },
          instructions: INSTRUCTIONS,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = msg.params?.name as string;
        try {
          return ok(await call(name, msg.params?.arguments ?? {}));
        } catch (e) {
          return ok({ content: [{ type: "text", text: `✗ ${(e as Error).message}` }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  });

  // When the client goes away, close the browser this server opened.
  const bye = async () => {
    if (startedPid) {
      const info = readSession();
      if (info?.pid === startedPid && (await sessionAlive(info).catch(() => false))) await stopSession();
    }
    process.exit(0);
  };
  rl.on("close", bye);
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}
