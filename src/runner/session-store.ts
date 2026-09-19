/**
 * A persistent browser session: `avr session start` launches a headless Chromium once,
 * logs in once, and stays alive. Later `avr` commands attach to it over CDP, so exploring
 * and inspecting a logged-in app costs nothing per call.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { resolveExecutablePath, ensureChromium } from "../browser.js";
import { resolveConfig } from "../config.js";
import type { BrowserConfig, UserScenarioConfig } from "../types.js";

export interface SessionInfo {
  pid: number;
  port: number;
  cdpUrl: string;
  userDataDir: string;
  startedAt: string;
  /** URL the session is currently on. */
  url?: string;
  note?: string;
  /** Port of the daemon's command server (`avr do`, `look`, journal). */
  controlPort?: number;
  /** Scenario file the session took its login setup from. */
  scenario?: string;
  /** False while login setup is still running. */
  ready?: boolean;
  setupError?: string;
}

export const DEFAULT_SESSION_FILE = ".avr/session.json";
export const DEFAULT_SESSION_PORT = 9222;

export function sessionFile(path?: string): string {
  return resolve(path ?? process.env.AVR_SESSION_FILE ?? DEFAULT_SESSION_FILE);
}

export function readSession(path?: string): SessionInfo | null {
  const file = sessionFile(path);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SessionInfo;
  } catch {
    return null;
  }
}

export function writeSession(info: SessionInfo, path?: string): string {
  const file = sessionFile(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(info, null, 2));
  return file;
}

export function clearSession(path?: string) {
  const file = sessionFile(path);
  if (existsSync(file)) rmSync(file, { force: true });
}

/** Is a session running and reachable? Returns the live CDP endpoint when it is. */
export async function sessionAlive(info: SessionInfo | null): Promise<boolean> {
  if (!info) return false;
  try {
    const b = await chromium.connectOverCDP(info.cdpUrl, { timeout: 4000 });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

/** Run the daemon in its own process group so it outlives the CLI invocation. */
export function startSessionDaemon(opts: {
  port: number;
  userDataDir: string;
  url?: string;
  setup?: string;
  config?: UserScenarioConfig;
  sessionPath?: string;
  log?: (msg: string) => void;
}): { pid: number } {
  const cfg = resolveConfig(opts.config);
  ensureChromium(cfg.browser);
  const args = [
    daemonEntry(),
    "--port", String(opts.port),
    "--user-data-dir", opts.userDataDir,
    "--session", sessionFile(opts.sessionPath),
    "--config", JSON.stringify(cfg),
  ];
  if (opts.url) args.push("--url", opts.url);
  if (opts.setup) args.push("--setup", opts.setup);

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, AVR_SESSION_DAEMON: "1" },
  });
  child.unref();
  return { pid: child.pid ?? -1 };
}

/** Path to this module's sibling daemon entry, resolved from the built output. */
function daemonEntry(): string {
  const here = new URL(import.meta.url).pathname;
  return join(dirname(here), "session-daemon.js");
}

/** Load a setup callback from a scenario file, so a session can log in the same way. */
export async function loadSetup(file: string): Promise<(page: import("playwright").Page) => Promise<void>> {
  const { loadScenario } = await import("../load-scenario.js");
  const scenario = await loadScenario(resolve(file));
  const setup = scenario.explore?.setup;
  if (!setup) throw new Error(`${file} has no explore.setup to run. Add one, or pass credentials with --login-url.`);
  return setup;
}

export type { BrowserConfig };

export interface CommandReply {
  ok: boolean;
  lines: string[];
}

/** Send a command to the daemon's control port. */
export async function sendCommand(info: SessionInfo, path: string, body: unknown): Promise<CommandReply> {
  if (!info.controlPort) throw new Error("This session was started by an older avr. Run `avr session stop` and start it again.");
  const res = await fetch(`http://127.0.0.1:${info.controlPort}${path}`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as CommandReply;
}

/** Wait until the daemon has published its session file and finished login setup. */
export async function waitForSession(pid: number, timeoutMs = 90000, path?: string): Promise<SessionInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const info = readSession(path);
    if (info && info.pid === pid && info.ready) return info;
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error("The session daemon exited during startup. Try `avr session start --headed`, or check that the port is free.");
    }
  }
  throw new Error(`Session did not become ready within ${timeoutMs / 1000}s (login setup still running?).`);
}

/**
 * The running session, starting one when there is none. Commands that need a live
 * browser call this, so an agent never has to remember `avr session start`.
 */
export async function ensureSession(opts: { scenario?: string; url?: string; config?: UserScenarioConfig; log?: (msg: string) => void } = {}): Promise<SessionInfo> {
  const existing = readSession();
  if (existing && existing.controlPort && (await sessionAlive(existing))) return existing;
  if (existing) {
    try {
      process.kill(existing.pid, "SIGTERM");
    } catch {}
    clearSession();
  }
  opts.log?.(`Starting a browser session${opts.scenario ? ` (logging in via ${opts.scenario})` : ""}…`);
  let config = opts.config;
  if (opts.scenario) {
    const { loadScenario } = await import("../load-scenario.js");
    const sc = await loadScenario(resolve(opts.scenario));
    config = { ...sc.config, ...(config ?? {}) };
  }
  const { pid } = startSessionDaemon({
    port: DEFAULT_SESSION_PORT,
    userDataDir: "/tmp/avr-session",
    url: opts.url,
    setup: opts.scenario ? resolve(opts.scenario) : undefined,
    config,
  });
  const info = await waitForSession(pid);
  if (info.setupError) opts.log?.(`Login setup failed: ${info.setupError}`);
  return info;
}
