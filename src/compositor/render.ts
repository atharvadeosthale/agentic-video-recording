import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { cpus } from "node:os";
import { chromium, type Browser } from "playwright";
import type { RecordingManifest, ScenarioConfig, UserScenarioConfig, Point } from "../types.js";
import { resolveConfig, resolveCursorSize } from "../config.js";
import { ensureChromium, resolveExecutablePath } from "../browser.js";
import { spawnFfmpeg, runFfmpeg } from "../ffmpeg.js";
import { clamp, lerp } from "../motion.js";
import { compositorHtml } from "./page.js";
import { buildTimeline, cameraBusyWindows, outToSource, planCamera, makeCameraEvaluator, extractCursor, cursorAt, frameIndexAt, crossesCut, planKeyToasts, keyHudAt, type KeyHud } from "./plan.js";

export interface RenderOptions {
  /** Directory containing manifest.json and frames/. */
  recordingDir: string;
  /** Output file. Default <recordingDir>/output.<format>. */
  outFile?: string;
  /** Overrides on top of the config stored in the manifest (frame, cursor, zoom, output...). */
  config?: UserScenarioConfig;
  /** Also write a tiled keyframe sheet next to the video. Default true. */
  contactSheet?: boolean;
  log?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface RenderResult {
  outFile: string;
  contactSheet?: string;
  durationMs: number;
  frames: number;
}

interface FrameInstruction {
  file: string;
  cam: { px: number; py: number; scale: number };
  cursor: { x: number; y: number; pressed: boolean; visible: boolean } | null;
  ripples: { x: number; y: number; p: number }[];
  uiScale: number;
  hud: KeyHud | null;
}

/**
 * Render the final video: background frame, camera zoom, synthetic cursor, click ripples,
 * idle trimming. Deterministic and re-runnable with different looks.
 */
export async function renderRecording(opts: RenderOptions): Promise<RenderResult> {
  const log = opts.log ?? (() => {});
  const dir = resolve(opts.recordingDir);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${dir}`);
  const manifest: RecordingManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const cfg: ScenarioConfig = resolveConfig(manifest.config, opts.config);
  const { width: W, height: H, fps } = cfg.output;
  const outFile = resolve(opts.outFile ?? join(dir, `output.${cfg.output.format}`));
  mkdirSync(dirname(outFile), { recursive: true });
  if (!manifest.frames.length) throw new Error("Recording has no frames. Did the scenario call startRecording() and do something visible?");

  // ---- Plan every frame up front (cheap, and lets workers be stateless) ----
  const vw = manifest.viewport.width, vh = manifest.viewport.height;
  const cameraKeys = planCamera(manifest, cfg);
  // Cuts must not land inside a camera move, so the timeline is built knowing where they are.
  const { ranges, outDuration } = buildTimeline(manifest, cfg, cameraBusyWindows(cameraKeys));
  const totalFrames = Math.max(1, Math.ceil((outDuration / 1000) * fps));
  const camAt = makeCameraEvaluator(cameraKeys, vw, vh);
  const { samples, downs } = extractCursor(manifest.events);
  const keyToasts = planKeyToasts(manifest.events, cfg);

  const pad = cfg.frame.padding;
  const availW = W - 2 * pad, availH = H - 2 * pad;
  const aspect = vw / vh;
  let cw = availW, ch = availW / aspect;
  if (ch > availH) { ch = availH; cw = availH * aspect; }
  const content = { x: (W - cw) / 2, y: (H - ch) / 2, w: cw, h: ch };
  const uiScale = cw / vw;

  const instructions: FrameInstruction[] = [];
  // Camera works in composition space (output px at scale 1): the whole canvas, padding and
  // background included, scales about the target the way Screen Studio does.
  const toComp = (p: Point) => ({ x: content.x + p.x * uiScale, y: content.y + p.y * uiScale });
  let prevSrc = -1;
  let followOffset: Point = { x: 0, y: 0 };
  const k = 1 - Math.pow(0.001, 1 / fps / 0.35); // ~350ms time constant for follow easing
  for (let i = 0; i < totalFrames; i++) {
    const tSrc = outToSource(ranges, (i * 1000) / fps);
    const fi = frameIndexAt(manifest.frames, tSrc);
    const cam = camAt(tSrc);
    const s = cam.scale;
    const cur = toComp(cursorAt(samples, tSrc));
    const target = toComp({ x: cam.cx, y: cam.cy });
    if (prevSrc >= 0 && crossesCut(ranges, prevSrc, tSrc)) followOffset = { x: 0, y: 0 };
    const visW = W / s, visH = H / s;
    if (cam.follow && s > 1.01 && cfg.zoom.followCursor) {
      const cx = target.x + followOffset.x, cy = target.y + followOffset.y;
      const inX = visW * 0.35, inY = visH * 0.35;
      let tx = followOffset.x, ty = followOffset.y;
      if (cur.x > cx + inX) tx += cur.x - (cx + inX);
      if (cur.x < cx - inX) tx -= cx - inX - cur.x;
      if (cur.y > cy + inY) ty += cur.y - (cy + inY);
      if (cur.y < cy - inY) ty -= cy - inY - cur.y;
      followOffset = { x: lerp(followOffset.x, tx, k), y: lerp(followOffset.y, ty, k) };
    } else {
      followOffset = { x: lerp(followOffset.x, 0, k), y: lerp(followOffset.y, 0, k) };
    }
    // Keep the visible window inside the composition so no empty edges appear.
    const px = clamp(target.x + followOffset.x, visW / 2, W - visW / 2);
    const py = clamp(target.y + followOffset.y, visH / 2, H - visH / 2);
    prevSrc = tSrc;
    const toOut = (p: Point) => ({ x: W / 2 + (p.x - px) * s, y: H / 2 + (p.y - py) * s });
    const pressed = downs.some((d) => tSrc >= d.t && tSrc <= d.up);
    const ripples = cfg.cursor.clickRipple
      ? downs.filter((d) => tSrc >= d.t && tSrc - d.t < 450).map((d) => ({ ...toOut(toComp(d)), p: (tSrc - d.t) / 450 }))
      : [];
    instructions.push({
      file: manifest.frames[fi].file,
      cam: { px, py, scale: s },
      cursor: cfg.cursor.enabled ? { ...toOut(cur), pressed, visible: samples.length > 0 } : null,
      ripples,
      uiScale: uiScale * Math.sqrt(s),
      hud: keyHudAt(keyToasts, tSrc),
    });
  }

  // ---- Render in parallel workers, each encoding its own segment ----
  const workers = clamp(cfg.output.workers ?? Math.min(6, cpus().length - 2), 1, 16);
  const perWorker = Math.ceil(totalFrames / workers);
  const chunks: [number, number][] = [];
  for (let s = 0; s < totalFrames; s += perWorker) chunks.push([s, Math.min(totalFrames, s + perWorker)]);
  log(`Rendering ${totalFrames} frames at ${W}x${H}@${fps} (${(outDuration / 1000).toFixed(1)}s) with ${chunks.length} worker${chunks.length > 1 ? "s" : ""}`);

  ensureChromium(cfg.browser);
  const segDir = join(dir, ".segments");
  rmSync(segDir, { recursive: true, force: true });
  mkdirSync(segDir, { recursive: true });
  const bg = cfg.frame.background;
  const bgImage = typeof bg === "object" ? "/bg/" + encodeURIComponent(isAbsolute(bg.image) ? bg.image : resolve(bg.image)) : undefined;
  const setup = {
    width: W, height: H,
    background: typeof bg === "string" ? bg : "#000",
    backgroundImage: bgImage,
    backgroundFit: typeof bg === "object" ? bg.fit : undefined,
    viewport: { width: vw, height: vh },
    shadow: cfg.frame.shadow, borderRadius: cfg.frame.borderRadius, cursor: { ...cfg.cursor, size: resolveCursorSize(cfg.cursor.size, H) },
    keys: { ...cfg.keys, fontSize: cfg.keys.fontSize * (H / 1080) },
    content,
  };
  const lossless = cfg.output.lossless;
  const isWebm = cfg.output.format === "webm";
  const encoderArgs = isWebm
    ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(cfg.output.crf), "-row-mt", "1", "-threads", "2"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", String(cfg.output.crf), "-pix_fmt", "yuv420p", "-threads", "2"];

  const start = Date.now();
  let done = 0;
  const report = () => opts.onProgress?.(done, totalFrames);
  const segments = await Promise.all(
    chunks.map(async ([from, to], idx) => {
      const segFile = join(segDir, `seg-${String(idx).padStart(3, "0")}.${cfg.output.format}`);
      const browser = await chromium.launch({ headless: true, executablePath: resolveExecutablePath(cfg.browser), args: ["--hide-scrollbars"] });
      try {
        const page = await openCompositorPage(browser, dir, setup);
        const ff = spawnFfmpeg(["-f", "image2pipe", "-vcodec", lossless ? "png" : "mjpeg", "-framerate", String(fps), "-i", "-", ...encoderArgs, "-r", String(fps), segFile]);
        for (let i = from; i < to; i++) {
          const ins = instructions[i];
          const b64: string = await page.evaluate(
            ({ ins, lossless }) => (window as any).__render(ins, lossless),
            { ins, lossless },
          );
          await ff.write(Buffer.from(b64, "base64"));
          done++;
          if (done % 30 === 0) report();
        }
        await ff.end();
        await ff.done;
      } finally {
        await browser.close().catch(() => {});
      }
      return segFile;
    }),
  );
  report();

  if (segments.length === 1) {
    await runFfmpeg(["-i", segments[0], "-c", "copy", "-movflags", "+faststart", outFile]);
  } else {
    const list = join(segDir, "list.txt");
    writeFileSync(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", ...(isWebm ? [] : ["-movflags", "+faststart"]), outFile]);
  }
  rmSync(segDir, { recursive: true, force: true });
  const took = Date.now() - start;
  log(`Encoded ${totalFrames} frames in ${(took / 1000).toFixed(1)}s (${(totalFrames / (took / 1000)).toFixed(1)} fps) -> ${outFile}`);

  let contactSheet: string | undefined;
  if (opts.contactSheet !== false) {
    contactSheet = join(dirname(outFile), "output-keyframes.jpg");
    const secs = outDuration / 1000;
    const every = Math.max(1, Math.round(secs / 12));
    const tiles = Math.max(1, Math.ceil(secs / every));
    const cols = Math.min(4, tiles);
    await runFfmpeg([
      "-i", outFile, "-vf", `fps=1/${every},scale=480:-1,tile=${cols}x${Math.ceil(tiles / cols)}`,
      "-frames:v", "1", "-q:v", "4", contactSheet,
    ]).catch((e) => log(`Keyframe sheet failed: ${e.message}`));
  }
  return { outFile, contactSheet, durationMs: outDuration, frames: totalFrames };
}

async function openCompositorPage(browser: Browser, dir: string, setup: Record<string, unknown>) {
  const framesDir = join(dir, "frames");
  const page = await browser.newPage({ viewport: { width: setup.width as number, height: setup.height as number }, deviceScaleFactor: 1 });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/frames/")) {
      const file = join(framesDir, url.pathname.slice("/frames/".length));
      return route.fulfill({ body: readFileSync(file), contentType: file.endsWith(".png") ? "image/png" : "image/jpeg" });
    }
    if (url.pathname === "/") return route.fulfill({ body: compositorHtml, contentType: "text/html" });
    if (url.pathname.startsWith("/bg/")) return route.fulfill({ body: readFileSync(decodeURIComponent(url.pathname.slice(4))) });
    return route.abort();
  });
  await page.goto("http://takeone.local/");
  await page.evaluate((c) => (window as any).__setup(c), setup);
  // Rasterise the CSS background (gradient or image) once and hand it to the canvas as a layer.
  await page.evaluate(() => (window as any).__showCanvas(false));
  if (setup.backgroundImage) await page.waitForLoadState("networkidle").catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  await cdp.detach();
  await page.evaluate((d) => (window as any).__setBackground(d), "data:image/png;base64," + shot.data);
  await page.evaluate(() => (window as any).__showCanvas(true));
  return page;
}
