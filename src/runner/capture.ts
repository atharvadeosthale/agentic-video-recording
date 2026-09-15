import type { CDPSession, Page } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureConfig, FrameIndexEntry } from "../types.js";

/**
 * Captures frames from a page using the DevTools screencast. Frames only arrive when
 * the page repaints, each tagged with a wall-clock timestamp, so the compositor can
 * reconstruct a constant frame rate without the runner having to hit a deadline.
 */
export class FrameCapture {
  private cdp!: CDPSession;
  private frames: FrameIndexEntry[] = [];
  private index = 0;
  private origin = 0;
  private active = false;
  private writing = true;
  private pending: Promise<void>[] = [];
  frameSize: { width: number; height: number } | null = null;

  constructor(
    private page: Page,
    private dir: string,
    private cfg: CaptureConfig,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Wall-clock ms of capture origin. Event timestamps are relative to this. */
  get originTime() {
    return this.origin;
  }

  now() {
    return Date.now() - this.origin;
  }

  async start() {
    if (this.active) return;
    this.origin = Date.now();
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (ev) => this.onFrame(ev));
    await this.cdp.send("Page.startScreencast", {
      format: this.cfg.format,
      quality: this.cfg.format === "jpeg" ? this.cfg.quality : undefined,
      everyNthFrame: 1,
    });
    this.active = true;
  }

  /** Skip writing frames to disk (used while recording is paused). */
  setWriting(on: boolean) {
    this.writing = on;
  }

  private onFrame(ev: { data: string; metadata: { timestamp?: number; deviceWidth: number; deviceHeight: number }; sessionId: number }) {
    const t = (ev.metadata.timestamp ?? Date.now() / 1000) * 1000 - this.origin;
    // Ack immediately so Chrome keeps producing frames.
    this.cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
    if (!this.writing) return;
    const buf = Buffer.from(ev.data, "base64");
    if (!this.frameSize) this.frameSize = readImageSize(buf, this.cfg.format);
    const file = `f${String(this.index++).padStart(6, "0")}.${this.cfg.format === "jpeg" ? "jpg" : "png"}`;
    this.frames.push({ t: Math.round(t), file });
    // Write synchronously in order; frames are a few hundred KB so this is cheap relative to the paint.
    writeFileSync(join(this.dir, file), buf);
  }

  async stop(): Promise<FrameIndexEntry[]> {
    if (!this.active) return this.frames;
    this.active = false;
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await Promise.all(this.pending);
    await this.cdp.detach().catch(() => {});
    return this.frames.sort((a, b) => a.t - b.t);
  }
}

function readImageSize(buf: Buffer, format: "jpeg" | "png"): { width: number; height: number } {
  if (format === "png") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk markers until SOF0/SOF2
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
  }
  throw new Error("Could not read JPEG size");
}
