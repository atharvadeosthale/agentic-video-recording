import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveFfmpeg(): string {
  const fromEnv = process.env.FFMPEG_PATH ?? process.env.AVR_FFMPEG_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`ffmpeg not found at ${fromEnv}`);
    return fromEnv;
  }
  try {
    const p: string | null = require("ffmpeg-static");
    if (p && existsSync(p)) return p;
  } catch {}
  try {
    const which = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
    const out = execSync(which, { encoding: "utf8" }).trim().split("\n")[0];
    if (out && existsSync(out)) return out;
  } catch {}
  throw new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH.");
}

export function ffmpegVersion(): string | undefined {
  try {
    return execSync(`"${resolveFfmpeg()}" -version`, { encoding: "utf8" }).split("\n")[0];
  } catch {
    return undefined;
  }
}

export interface FfmpegProcess {
  stdin: NodeJS.WritableStream;
  done: Promise<void>;
  write: (buf: Buffer) => Promise<void>;
  end: () => Promise<void>;
}

/** Spawn ffmpeg with the given args, returning a handle that respects backpressure on stdin. */
export function spawnFfmpeg(args: string[], opts: { onLog?: (s: string) => void } = {}): FfmpegProcess {
  const bin = resolveFfmpeg();
  const proc = spawn(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["pipe", "inherit", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
    opts.onLog?.(d.toString());
  });
  const done = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}\n${stderr}`))));
  });
  // Swallow EPIPE if ffmpeg dies early; the `done` promise carries the real error.
  proc.stdin.on("error", () => {});
  const write = (buf: Buffer) =>
    new Promise<void>((resolve) => {
      if (proc.stdin.write(buf)) resolve();
      else proc.stdin.once("drain", () => resolve());
    });
  const end = () =>
    new Promise<void>((resolve) => {
      proc.stdin.end(() => resolve());
    });
  return { stdin: proc.stdin, done, write, end };
}

export function runFfmpeg(args: string[]): Promise<void> {
  const p = spawnFfmpeg(args);
  return p.end().then(() => p.done);
}
