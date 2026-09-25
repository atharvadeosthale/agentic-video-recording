/**
 * Public configuration and event types.
 */

export type EasingName = "linear" | "smooth" | "snappy" | "spring" | "easeOut" | "easeIn";
export type Easing = EasingName | [number, number, number, number];

export interface ViewportConfig {
  /** CSS pixel width of the browser viewport. Default 1920. */
  width: number;
  /** CSS pixel height of the browser viewport. Default 1080. */
  height: number;
  /** Device scale factor. 2 gives a crisp "retina" capture and headroom for zoom. Default 2. */
  deviceScaleFactor: number;
}

export interface OutputConfig {
  /** Output video width in pixels. Default 1920. */
  width: number;
  /** Output video height in pixels. Default 1080. */
  height: number;
  /** Output frames per second. Default 60. */
  fps: number;
  /** Container/codec. Default mp4 (H.264). */
  format: "mp4" | "webm";
  /** Constant rate factor for the encoder. Lower is better quality. Default 18. */
  crf: number;
  /** Use lossless PNG intermediates between compositor and encoder. Slower. Default false (JPEG q95). */
  lossless: boolean;
  /** Parallel render workers (browser processes). Default: CPU count minus 2, capped at 6. */
  workers?: number;
}

export interface ShadowConfig {
  blur: number;
  offsetY: number;
  color: string;
}

export interface FrameConfig {
  /** Padding around the browser content, in output pixels. Default 96. */
  padding: number;
  /** CSS color, gradient, or `{ image: "path" }`. Default a soft gradient. */
  background: string | { image: string; fit?: "cover" | "contain" };
  /** Corner radius of the browser content, in output pixels. Default 16. */
  borderRadius: number;
  /** Drop shadow behind the content. `false` disables. */
  shadow: ShadowConfig | false;
}

export type CursorSizePreset = "small" | "default" | "large" | "xl";
export type CursorSpeedPreset = "slow" | "normal" | "fast";

export interface CursorConfig {
  /** Draw a synthetic cursor in post. Default true. */
  enabled: boolean;
  /**
   * Cursor size. A preset (`small` 24, `default` 36, `large` 48, `xl` 64) or an explicit height in
   * output pixels at 1080p; scales with the output resolution. Default "default".
   */
  size: CursorSizePreset | number;
  /** Cursor style. */
  style: "arrow" | "dot";
  /** Draw an expanding ring on clicks. Default true. */
  clickRipple: boolean;
  /** Shrink the cursor slightly while the button is held. Default true. */
  clickScale: boolean;
  /** Cursor colour for the `dot` style / accent. */
  color: string;
}

export interface ZoomConfig {
  /** Zoom automatically toward clicks and typing targets. Default true. */
  auto: boolean;
  /** Scale used by automatic zooms. Default 1.6. */
  autoScale: number;
  /** How long an automatic zoom stays after the last interaction before easing out, in ms. Default 1500. */
  autoHold: number;
  /** How far ahead of a click the automatic zoom starts, in ms, so the camera is already in when the click lands. Default 600. */
  autoLead: number;
  /** Default transition duration for zoom moves, in ms. Default 700. */
  duration: number;
  /** Default easing for zoom moves. */
  easing: Easing;
  /** Maximum allowed scale. Default 3. */
  maxScale: number;
  /** Margin, as a fraction of the viewport, kept around an element when zooming onto it. Default 0.12. */
  margin: number;
  /** Keep the cursor in view by panning while zoomed. Default true. */
  followCursor: boolean;
}

export interface MotionConfig {
  /** Cursor travel speed: a preset (`slow` 0.6, `normal` 0.9, `fast` 1.6 CSS px per ms) or a number. Default "normal". */
  cursorSpeed: CursorSpeedPreset | number;
  /** Minimum cursor travel duration in ms. Default 350. */
  minMoveDuration: number;
  /** Maximum cursor travel duration in ms. Default 1600. */
  maxMoveDuration: number;
  /** Cursor path easing. */
  easing: Easing;
  /** How long the mouse button is held on a click, in ms. Default 90. */
  clickHold: number;
  /** Default typing speed in words per minute. Default 220. */
  wpm: number;
  /** Random variation of per-key delay, 0 to 1. Default 0.35. */
  typingJitter: number;
  /** Default scroll duration in ms. Default 600. */
  scrollDuration: number;
}

/**
 * How a wait appears in the finished video.
 * - `"keep"` (default): shown in full, real time. Waiting is the default so a slow step
 *   such as provisioning is visible rather than silently cut.
 * - `"trim"`: shortened to `idleTrim.keep`.
 * - a number: time-lapse, played that many times faster (`8` = 8x).
 */
export type WaitEdit = "trim" | "keep" | number;

export interface IdleTrimConfig {
  /**
   * Master switch for trimming. Waits play in real time by default; this only governs
   * waits that explicitly ask to be trimmed with `edit: "trim"`. Default true.
   */
  enabled: boolean;
  /** Idle stretches longer than this (ms) are shortened. Default 1500. */
  threshold: number;
  /** What an idle stretch is shortened to, in ms. Default 600. */
  keep: number;
  /**
   * Never cut inside a camera animation. A cut that overlaps a zoom would otherwise jump
   * the camera mid-move, which reads as a broken zoom. Default true.
   */
  protectCamera: boolean;
}

export interface BrowserConfig {
  /** Path to a Chromium/Chrome executable. Defaults to the Playwright-managed Chromium. */
  executablePath?: string;
  /** Run with a visible window (only useful on machines with a display). Default false. */
  headless: boolean;
  /** Playwright storage state (cookies, localStorage, IndexedDB) file or object. */
  storageState?: string;
  /** Persistent user data directory. Enables a real profile with extensions and all storage. */
  userDataDir?: string;
  /** Extra Chromium args. */
  args?: string[];
  /** Locale, timezone, colour scheme passthrough. */
  locale?: string;
  timezoneId?: string;
  colorScheme?: "light" | "dark";
  /** Default timeout for locators and navigation in ms. Default 15000. */
  timeout: number;
  /** Rewrite target=_blank links so navigation stays in the recorded tab. Default true. */
  sameTabLinks: boolean;
}

export interface CaptureConfig {
  /** Image format for raw captured frames. jpeg is much faster at high resolutions. Default jpeg. */
  format: "jpeg" | "png";
  /** JPEG quality 0-100. Default 92. */
  quality: number;
}

export interface KeysConfig {
  /**
   * Which key presses get an on-screen overlay.
   * `shortcuts`: chords and special keys from press() only. `all`: also typed text.
   * `manual`: only steps that pass `showKeys: true`. `off`: never.
   */
  mode: "shortcuts" | "all" | "manual" | "off";
  /** How long a shortcut stays visible after the last key, ms. Default 1200. */
  hold: number;
  /** Typed characters closer together than this join one pill, ms. Default 900. */
  gap: number;
  /** Glyph style: ⌘ ⌥ ⌃ ⇧ for mac, Ctrl/Alt/Win for windows. Default mac. */
  platform: "mac" | "windows";
  /** Vertical placement. Default bottom. */
  position: "bottom" | "top";
  /** Distance from the frame edge as a fraction of output height. Default 0.1. */
  offset: number;
  /** Font size in output px at 1080p. Default 30. */
  fontSize: number;
}

export interface ExploreConfig {
  /** Where `takeone explore` writes the inventory index. Default ".takeone/inventory.json". */
  index: string;
  /** Max elements to inventory per page. Default 250. */
  max: number;
  /** Scroll the page while inventorying so off-screen elements are included. Default true. */
  scroll: boolean;
}

export interface DryRunConfig {
  /** Scale screenshots down by this factor for cheaper contact sheets. Default 0.5. */
  scale: number;
  /** Emit a single contact sheet image. Default true. */
  contactSheet: boolean;
  /** Columns in the contact sheet. Default 3. */
  columns: number;
}

export interface ScenarioConfig {
  /** Human readable name, used for the output folder. */
  name?: string;
  viewport: ViewportConfig;
  output: OutputConfig;
  frame: FrameConfig;
  cursor: CursorConfig;
  zoom: ZoomConfig;
  motion: MotionConfig;
  idleTrim: IdleTrimConfig;
  browser: BrowserConfig;
  capture: CaptureConfig;
  keys: KeysConfig;
  dryRun: DryRunConfig;
  explore: ExploreConfig;
  /** Path to the inventory index used to resolve @eNN handles. Default ".takeone/inventory.json". */
  indexPath?: string;
}

/** Deep partial helper for user-facing config. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[]
    ? U[]
    : T[K] extends object
      ? T[K] extends Function
        ? T[K]
        : DeepPartial<T[K]>
      : T[K];
};

export type UserScenarioConfig = DeepPartial<ScenarioConfig>;

// ---------------------------------------------------------------------------
// Event log (written by the runner, consumed by the compositor)
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export interface CameraTarget {
  /** Centre of the camera in viewport CSS px. */
  cx: number;
  cy: number;
  scale: number;
}

export type RecordedEvent =
  | { type: "mouse"; t: number; x: number; y: number }
  | { type: "mousedown"; t: number; x: number; y: number; button: string }
  | { type: "mouseup"; t: number; x: number; y: number; button: string }
  | { type: "key"; t: number; key: string; x?: number; y?: number; source?: "press" | "type"; show?: boolean }
  | { type: "scroll"; t: number; dx: number; dy: number }
  | { type: "zoom"; t: number; target: CameraTarget; duration: number; easing: Easing; follow?: boolean; source: "manual" | "auto" }
  | { type: "zoomOut"; t: number; duration: number; easing: Easing; source: "manual" | "auto" }
  | { type: "autoZoomOff"; t: number }
  | { type: "autoZoomOn"; t: number }
  | { type: "idle"; t: number; end: number; reason: string; edit?: WaitEdit }
  | { type: "step"; t: number; name: string; detail?: string }
  | { type: "recording"; t: number; state: "start" | "pause" | "resume" | "stop" };

export interface FrameIndexEntry {
  /** Time in ms relative to recording origin. */
  t: number;
  /** File name inside the frames directory. */
  file: string;
}

export interface RecordingManifest {
  version: 1;
  createdAt: string;
  config: ScenarioConfig;
  /** CSS viewport size the page was rendered at. */
  viewport: ViewportConfig;
  /** Actual pixel size of the captured frames. */
  frameSize: { width: number; height: number };
  frames: FrameIndexEntry[];
  events: RecordedEvent[];
  /** Total wall-clock duration of the capture, ms. */
  duration: number;
}
