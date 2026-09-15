import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { BrowserConfig } from "./types.js";
import { ensureChromium, resolveExecutablePath } from "./browser.js";

export interface SheetItem {
  file: string;
  label: string;
}

export interface SheetOptions {
  columns: number;
  /** Width of each cell in px. */
  cellWidth: number;
  /** Width / height of each image. */
  aspect: number;
  browser: BrowserConfig;
  /** JPEG quality. Default 80. */
  quality?: number;
}

/**
 * Tile images into one labelled JPEG using a throwaway Chromium page. One image
 * is far cheaper for an agent to look at than a dozen.
 */
export async function makeContactSheet(items: SheetItem[], outPath: string, opts: SheetOptions) {
  ensureChromium(opts.browser);
  const browser = await chromium.launch({ headless: true, executablePath: resolveExecutablePath(opts.browser) });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const gap = 12, labelH = 28;
    const cols = Math.max(1, Math.min(opts.columns, items.length));
    const rows = Math.ceil(items.length / cols);
    const cellW = opts.cellWidth;
    const imgH = Math.round(cellW / opts.aspect);
    const width = cols * cellW + (cols + 1) * gap;
    const height = rows * (imgH + labelH) + (rows + 1) * gap;
    const cells = items
      .map((it) => {
        const mime = extname(it.file).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
        const data = readFileSync(it.file).toString("base64");
        return `<div class="cell"><img src="data:${mime};base64,${data}"><div class="label">${escapeHtml(it.label)}</div></div>`;
      })
      .join("");
    await page.setViewportSize({ width, height });
    await page.setContent(`<!doctype html><html><head><style>
      body{margin:0;background:#111;font-family:ui-sans-serif,system-ui,sans-serif;color:#eee}
      .grid{display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:${gap}px;padding:${gap}px}
      .cell img{width:${cellW}px;height:${imgH}px;object-fit:cover;display:block;background:#000;border-radius:4px}
      .label{height:${labelH}px;line-height:${labelH}px;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style></head><body><div class="grid">${cells}</div></body></html>`);
    await page.screenshot({ path: outPath, type: "jpeg", quality: opts.quality ?? 80, fullPage: true });
  } finally {
    await browser.close();
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
