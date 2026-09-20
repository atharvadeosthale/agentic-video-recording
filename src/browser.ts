import { chromium, type Browser, type BrowserContext } from "playwright";
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { BrowserConfig, ViewportConfig } from "./types.js";

export function resolveExecutablePath(cfg: BrowserConfig): string | undefined {
  const fromEnv = process.env.AVR_CHROMIUM_PATH;
  const p = cfg.executablePath ?? fromEnv;
  if (p) {
    if (!existsSync(p)) throw new Error(`Chromium executable not found at ${p}`);
    return p;
  }
  return undefined;
}

/** Make sure the Playwright-managed Chromium exists, downloading it if needed. */
export function ensureChromium(cfg: BrowserConfig, log: (s: string) => void = () => {}) {
  if (resolveExecutablePath(cfg)) return;
  const managed = chromium.executablePath();
  if (managed && existsSync(managed)) return;
  log("Chromium not found, downloading via Playwright (one time)...");
  const res = spawnSync(process.execPath, [require.resolve("playwright/cli"), "install", "chromium"], {
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error("Failed to install Chromium. Run `npx playwright install chromium` manually or set browser.executablePath.");
}

// `require` shim for ESM
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** Keeps target=_blank links and window.open in the recorded tab. */
export const SAME_TAB_SCRIPT = `document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[target="_blank"]') : null;
    if (a) a.target = '_self';
  }, true); window.open = (u) => { if (u) location.href = String(u); return window; };`;

/**
 * Scenario files are compiled by tsx, whose esbuild settings wrap every named function in
 * a `__name()` call. A function passed to `page.evaluate` is serialized without that
 * helper, so the page needs its own copy or the call throws `__name is not defined`.
 */
export const NAME_HELPER_SCRIPT = `globalThis.__name ??= (fn) => fn;`;

export interface LaunchedBrowser {
  browser?: Browser;
  context: BrowserContext;
  close: () => Promise<void>;
}

export async function launchBrowser(cfg: BrowserConfig, viewport: ViewportConfig, log?: (s: string) => void): Promise<LaunchedBrowser> {
  ensureChromium(cfg, log);
  const executablePath = resolveExecutablePath(cfg);
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--hide-scrollbars",
    "--disable-smooth-scrolling",
    "--font-render-hinting=none",
    "--disable-features=TranslateUI",
    "--autoplay-policy=no-user-gesture-required",
    ...(cfg.args ?? []),
  ];
  const contextOptions = {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    locale: cfg.locale,
    timezoneId: cfg.timezoneId,
    colorScheme: cfg.colorScheme,
    ignoreHTTPSErrors: true,
  };

  const sameTab = SAME_TAB_SCRIPT;

  if (cfg.userDataDir) {
    const context = await chromium.launchPersistentContext(cfg.userDataDir, {
      headless: cfg.headless,
      executablePath,
      args,
      ...contextOptions,
    });
    context.setDefaultTimeout(cfg.timeout);
    await context.addInitScript(NAME_HELPER_SCRIPT);
    if (cfg.sameTabLinks) await context.addInitScript(sameTab);
    return { context, close: () => context.close() };
  }

  const browser = await chromium.launch({ headless: cfg.headless, executablePath, args });
  const context = await browser.newContext({
    ...contextOptions,
    storageState: cfg.storageState,
  });
  context.setDefaultTimeout(cfg.timeout);
  await context.addInitScript(NAME_HELPER_SCRIPT);
  if (cfg.sameTabLinks) await context.addInitScript(sameTab);
  return {
    browser,
    context,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Connect to a browser started by `avr session start`, instead of launching one. The
 * returned handle never closes the browser: the daemon owns its lifetime.
 */
export async function connectToSession(port: number, cfg: BrowserConfig): Promise<LaunchedBrowser> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`Session on port ${port} has no browser context.`);
  context.setDefaultTimeout(cfg.timeout);
  return { browser, context, close: async () => { await browser.close().catch(() => {}); } };
}

export function chromiumInfo(cfg: BrowserConfig): { path: string; version?: string } {
  const path = resolveExecutablePath(cfg) ?? chromium.executablePath();
  let version: string | undefined;
  try {
    version = execSync(`"${path}" --version`, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {}
  return { path, version };
}
