/**
 * `avr explore`: visit pages once, inventory every interactive element, and write an
 * index that scenarios can point at by handle. One browser launch instead of one per probe.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { collectInventory, type InventoryBundle, type InventoryPage } from "../inventory.js";
import { indexFromPages, normalizeIndex, type AvrIndex } from "../resolver.js";
import { launchBrowser, connectToSession } from "../browser.js";
import { readSession, sessionAlive } from "./session-store.js";
import { resolveConfig } from "../config.js";
import { makeContactSheet } from "../contact-sheet.js";
import type { ScenarioConfig, UserScenarioConfig } from "../types.js";
import type { Page } from "playwright";

export interface ExplorePageSpec {
  /**
   * Path or absolute URL to visit. Use `"auto"` for wherever the browser already is,
   * which is what a login redirect lands on. Avoids hardcoding organization or project IDs.
   */
  path: string;
  /** Optional label used in the artifact. Defaults to the page title. */
  label?: string;
  /** Wait for this locator before inventorying, so late-rendered UI is included. */
  waitFor?: string;
  /** Extra settle time after load, ms. */
  settle?: number;
  /** Actions to run on this page before inventorying it (clicking into a sub-view). */
  prepare?: (page: Page) => Promise<void>;
}

export interface ExploreOptions {
  /** Pages to visit, in order. */
  pages: ExplorePageSpec[];
  outDir: string;
  /** Base URL prepended to relative paths. */
  baseUrl?: string;
  /** Login/setup run once before the walk. Receives the page. */
  setup?: (page: Page) => Promise<void>;
  config?: UserScenarioConfig;
  log?: (msg: string) => void;
  /** Also write an HTML page listing handles next to screenshots. Default true. */
  html?: boolean;
  /** Ignore a live `avr session` and launch a fresh browser. */
  noSession?: boolean;
}

export interface ExploreResult {
  outDir: string;
  indexPath: string;
  index: AvrIndex;
  bundle: InventoryBundle;
  sheets: string[];
  html?: string;
}

export async function exploreScenario(opts: ExploreOptions): Promise<ExploreResult> {
  const log = opts.log ?? (() => {});
  const config: ScenarioConfig = resolveConfig(opts.config);
  const outDir = resolve(opts.outDir);
  const shotsDir = join(outDir, "pages");
  mkdirSync(shotsDir, { recursive: true });

  // Attach to a live `avr session` when there is one: the login already happened, so the
  // walk costs nothing per page.
  const session = readSession();
  const useSession = !opts.noSession && session && (await sessionAlive(session));
  let launched: { context: import("playwright").BrowserContext; close: () => Promise<void> };
  if (useSession) {
    log(`Attaching to session ${session!.cdpUrl} (already logged in)`);
    launched = await connectToSession(session!.port, config.browser);
  } else {
    log(`Launching Chromium (${config.viewport.width}x${config.viewport.height})`);
    launched = await launchBrowser(config.browser, config.viewport, log);
  }
  const page = launched.context.pages()[0] ?? (await launched.context.newPage());

  const pages: InventoryPage[] = [];
  const sheets: { url: string; file: string }[] = [];
  const rawShots: { file: string; label: string }[] = [];

  try {
    if (opts.setup && !useSession) {
      log("Running setup (login etc.)");
      await opts.setup(page);
    } else if (opts.setup && useSession) {
      log("Session already logged in; skipping setup");
    }

    let i = 0;
    for (const spec of opts.pages) {
      i++;
      if (spec.path === "auto") {
        // Stay where the setup left us: the post-login landing page.
        log(`[${i}/${opts.pages.length}] ${page.url()} (auto)`);
      } else {
        const url = /^https?:/.test(spec.path) ? spec.path : `${opts.baseUrl ?? ""}${spec.path}`;
        log(`[${i}/${opts.pages.length}] ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
      if (spec.waitFor) await page.locator(spec.waitFor).first().waitFor({ state: "visible", timeout: config.browser.timeout });
      // SPAs render after load: wait for the element count to stop growing instead of
      // guessing a settle time, so a slow hydration never yields an empty inventory.
      await waitForStableInventory(page, config, spec.settle, log);
      if (spec.prepare) {
        await spec.prepare(page);
        await waitForStableInventory(page, config, spec.settle, log);
      }

      const inv = (await page.evaluate(collectInventory, {
        max: config.explore.max,
        scroll: config.explore.scroll,
      })) as InventoryPage;
      inv.url = page.url();
      pages.push(inv);
      log(`  ${inv.elements.length} elements${inv.truncated ? " (truncated)" : ""}, ${inv.ambiguous.length} ambiguous`);

      const shot = join(shotsDir, `page-${String(i).padStart(2, "0")}.jpg`);
      // A heavy page can time out the screenshot. The inventory is the product; keep it.
      try {
        await page.screenshot({ path: shot, type: "jpeg", quality: 82, timeout: 10000 });
        rawShots.push({ file: shot, label: `${i}. ${spec.label ?? inv.title ?? inv.url}` });
      } catch (e) {
        log(`  (no screenshot for this page: ${(e as Error).message.split("\n")[0]})`);
      }
    }
  } finally {
    await launched.close();
  }

  const bundle: InventoryBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    pages,
    sheets,
  };
  const index = indexFromPages(pages);

  // The index is what scenarios resolve handles against. Keep entries for pages we
  // did not visit this run so their handles stay resolvable.
  const indexPath = resolve(config.explore.index);
  mkdirSync(dirname(indexPath), { recursive: true });
  const merged = mergeIndex(indexPath, index);
  writeFileSync(indexPath, JSON.stringify(merged, null, 2));
  writeFileSync(join(outDir, "inventory.json"), JSON.stringify(bundle, null, 2));
  log(`Index -> ${indexPath}`);

  let sheetPath: string | undefined;
  if (rawShots.length) {
    sheetPath = join(outDir, "pages.jpg");
    await makeContactSheet(rawShots, sheetPath, {
      columns: 2,
      cellWidth: Math.round(config.viewport.width * 0.42),
      aspect: config.viewport.width / config.viewport.height,
      browser: config.browser,
    });
    log(`Page sheet -> ${sheetPath}`);
  }

  let htmlPath: string | undefined;
  if (opts.html !== false) {
    htmlPath = join(outDir, "inventory.html");
    writeFileSync(htmlPath, renderHtml(bundle, merged, outDir, rawShots));
  }

  return { outDir, indexPath, index, bundle, sheets: sheetPath ? [sheetPath] : [], html: htmlPath };
}

/**
 * Poll the inventory until the element count stops changing, so late-hydrating SPAs are
 * captured whole without an arbitrary wait. `settle` acts as a floor, not the mechanism.
 */
async function waitForStableInventory(
  page: Page,
  config: ScenarioConfig,
  settle: number | undefined,
  log: (msg: string) => void,
) {
  const minWait = settle ?? 800;
  const deadline = Date.now() + config.browser.timeout;
  // A loading skeleton is a stable DOM, so waiting for network activity to end is what
  // actually distinguishes "rendered" from "about to render". Realtime/websocket pages
  // may never go idle, so a timeout here is expected and not an error.
  await page.waitForLoadState("networkidle", { timeout: Math.min(config.browser.timeout, 20000) }).catch(() => {});
  await page.waitForTimeout(Math.min(minWait, 1500));
  let prev = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const count = await page
      .evaluate(() => {
        let n = 0;
        for (const el of document.querySelectorAll("a[href], button, input, select, textarea, [role], summary, h1, h2, h3")) {
          const r = el.getBoundingClientRect();
          if (r.width >= 1 && r.height >= 1) n++;
        }
        return n;
      })
      .catch(() => prev);
    if (count === prev) stable++;
    else {
      stable = 0;
      prev = count;
    }
    if (stable >= 2) {
      if (settle && Date.now() < deadline) await page.waitForTimeout(Math.max(0, minWait - 1500));
      return;
    }
    await page.waitForTimeout(400);
  }
  log("  (inventory did not fully stabilize; using the last reading)");
}

/** Keep handles resolvable for pages that were inventoried in an earlier run. */
function mergeIndex(indexPath: string, fresh: AvrIndex): AvrIndex {
  try {
    if (!existsSync(indexPath)) return fresh;
    const prev = normalizeIndex(JSON.parse(readFileSync(indexPath, "utf8")) as AvrIndex);
    const freshUrls = new Set(fresh.pages.map((p) => p.url));
    const kept = prev.pages.filter((p) => !freshUrls.has(p.url));
    if (!kept.length) return fresh;
    return { version: 1, createdAt: new Date().toISOString(), pages: [...kept, ...fresh.pages] };
  } catch {
    // A corrupt index is not fatal: the fresh one replaces it.
    return fresh;
  }
}

function renderHtml(bundle: InventoryBundle, index: AvrIndex, outDir: string, shots: { file: string; label: string }[]): string {
  const sections = bundle.pages
    .map((p, i) => {
      const shot = shots.find((sh) => sh.label.startsWith(`${i + 1}. `));
      const rel = shot ? shot.file.replace(outDir + "/", "") : "";
      const entry = (e: any) => index?.pages.flatMap((q) => q.elements).find((q) => q.handle === e.handle);
      const rows = p.elements
        .map((e) => {
          const t = (entry(e) as any)?.target;
          return (
            `<tr><td class="h">${esc(e.handle)}</td><td>${esc(e.role)}</td><td>${esc(e.name)}</td>` +
            `<td>${e.x},${e.y}</td><td>${e.width}x${e.height}</td>` +
            `<td class="m">${esc(t ? JSON.stringify(t) : "")}</td></tr>`
          );
        })
        .join("");
      const amb = p.ambiguous.length
        ? `<details><summary>${p.ambiguous.length} ambiguous</summary><ul>${p.ambiguous
            .map((a) => `<li>${esc(a.handle)} ${esc(a.role)} "${esc(a.name)}" -> <code>${esc(a.suggestion)}</code></li>`)
            .join("")}</ul></details>`
        : "";
      return `<section><h2>${i + 1}. ${esc(p.title || p.url)}</h2><p class="u">${esc(p.url)}</p>
${rel ? `<img src="${esc(rel)}" alt="">` : ""}
${amb}
<table><thead><tr><th>handle</th><th>role</th><th>name</th><th>at</th><th>size</th><th>target</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>avr inventory</title><style>
body{font:14px ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
h1{margin-top:0}h2{margin:28px 0 4px}.u{color:#8b95a5;margin:0 0 12px;font-size:12px}
img{max-width:100%;border-radius:8px;display:block;margin:0 0 12px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{text-align:left;padding:5px 10px;border-bottom:1px solid #23262e}
th{color:#9aa4b2;font-weight:600}
.h{font-family:ui-monospace,monospace;color:#7dd3fc}
.m{color:#8b95a5;font-family:ui-monospace,monospace}
code{background:#1b1f27;padding:1px 5px;border-radius:4px}
details{margin:8px 0}
</style></head><body><h1>Element inventory</h1><p class="u">generated ${esc(bundle.createdAt)}</p>${sections}</body></html>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
