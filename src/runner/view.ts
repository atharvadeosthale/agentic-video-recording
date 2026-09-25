/**
 * The view: a screenshot of the session page with every numbered element boxed and labelled,
 * so an agent can look once and act by number. The labels are drawn in a throwaway tab over
 * a plain screenshot. The app's own page is never touched, so its DOM, focus and observers
 * see nothing.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { Observation } from "../observe.js";

/** Width of the view image. Wide enough to read UI text, small enough to stay cheap to look at. */
const VIEW_WIDTH = 1280;
/** Views kept on disk; older ones are deleted as new ones are written. */
const KEEP = 12;

const PALETTE = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#9333ea", "#0891b2", "#db2777", "#4d7c0f"];

export class ViewWriter {
  readonly dir: string;
  private seq = 0;

  constructor(port: number) {
    this.dir = join(tmpdir(), `takeone-view-${port}`);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  /** Screenshot the page and draw the observation's numbers on it. Returns the file path. */
  async write(context: BrowserContext, page: Page, obs: Observation, name: string): Promise<string> {
    const vp = page.viewportSize() ?? { width: 1920, height: 1080 };
    const raw = await page.screenshot({ type: "jpeg", quality: 80, scale: "css", timeout: 5000 });
    const k = VIEW_WIDTH / vp.width;
    const H = Math.round(vp.height * k);
    const regions = [...new Set(obs.elements.map((e) => e.region ?? "page"))];
    const marks = obs.elements
      .filter((e) => e.label && !e.offscreen && e.width > 0 && e.height > 0)
      .map((e) => {
        const color = PALETTE[regions.indexOf(e.region ?? "page") % PALETTE.length];
        const x = Math.max(0, e.x * k), y = Math.max(0, e.y * k), w = e.width * k, h = e.height * k;
        // The badge sits just outside the box so it never hides the element's own text:
        // above it, else to its left, else inside the corner as a last resort.
        const bw = 7 * String(e.label).length + 6;
        const [bx, by, pos] = y >= 15 ? [x, y - 15, "top"] : x >= bw + 1 ? [x - bw - 1, y, "left"] : [x, y, "in"];
        return (
          `<div style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:1.5px solid ${color}${e.covered ? ";border-style:dashed" : ""}" class="b"></div>` +
          `<div style="left:${bx}px;top:${by}px;background:${color}" class="n ${pos}">${e.label}</div>`
        );
      })
      .join("");
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;background:#000}
      .v{position:relative;width:${VIEW_WIDTH}px;height:${H}px;overflow:hidden}
      .v img{width:100%;height:100%;display:block}
      .b{position:absolute;box-sizing:border-box;border-radius:3px}
      .n{position:absolute;color:#fff;font:700 11px/15px ui-monospace,Menlo,Consolas,monospace;padding:0 3px;border-radius:3px;opacity:.92}
      </style></head><body><div class="v"><img src="data:image/jpeg;base64,${raw.toString("base64")}">${marks}</div></body></html>`;
    const file = join(this.dir, `${String(++this.seq).padStart(3, "0")}-${name}.jpg`);
    const tab = await context.newPage();
    try {
      await tab.setViewportSize({ width: VIEW_WIDTH, height: H });
      await tab.setContent(html, { waitUntil: "load" });
      await tab.screenshot({ path: file, type: "jpeg", quality: 75, scale: "css" });
    } finally {
      await tab.close().catch(() => {});
    }
    this.prune();
    return file;
  }

  private prune() {
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".jpg")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) rmSync(join(this.dir, f), { force: true });
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
