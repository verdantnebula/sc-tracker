// ============================================================================
// settings.ts — per-user, runtime-writable app settings (main process)
// ----------------------------------------------------------------------------
// Persists user-chosen preferences that must survive across launches. Today the
// only setting is a custom StarCitizen `\LIVE\` folder, for players who install
// the game off the default drive (the watcher otherwise sits empty).
//
// Storage lives at `app.getPath('userData')/settings.json` — a per-user file,
// SEPARATE from the bundled reference snapshot (read-only, in the asar) and the
// mission DB (sqlite). Never write settings into either of those.
//
// Defensive by design (mirrors config.ts): a missing or corrupt settings file
// must NEVER stop the app booting — load() returns safe defaults on any error,
// and save() merges onto the current on-disk state so a partial write can't drop
// unrelated keys. The pure path-resolution helpers take an injectable existence
// predicate so they can be unit-tested without touching the real filesystem.
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

import type { AppMode } from "@shared/types";

import { DEFAULT_GAME_LOG_PATH } from "./logWatcher";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface AppSettings {
  /**
   * User-chosen StarCitizen `\LIVE\` folder (the directory that directly
   * contains Game.log). null when unset -> the watcher uses the default path.
   * We store the FOLDER (not the Game.log path) because the game recreates
   * Game.log every session; the folder is the stable anchor and the logbackups
   * sibling is derived from it.
   */
  liveFolder: string | null;
  /**
   * Which tracker the app shows on launch ('cargo' | 'salvage'). Defaults to
   * 'cargo' so existing users see no change. Persisted so the chosen mode
   * survives a restart.
   */
  mode: AppMode;
  /**
   * Slug of the user's selected cargo ship (Phase A ship picker), matched against
   * a ShipReference.slug in the bundled reference snapshot. null when unset ->
   * the capacity bar shows the "pick a ship" prompt. Persisted so the chosen ship
   * survives a restart. Stored as a slug (not name) for stable identity.
   */
  selectedShipSlug: string | null;
  /**
   * Whether the always-on-top "next stop" overlay window (Phase D) was open. On
   * launch the overlay is recreated IFF this is true, so the user's choice to
   * keep it pinned survives a restart. The overlay's own close/unpin control
   * flips this back to false.
   */
  overlayEnabled: boolean;
  /**
   * Last position + size of the overlay window, persisted (debounced) on move /
   * resize so it reopens where the user left it. null when never moved -> the
   * overlay uses its small default and is centered by the OS. Clamped to a
   * visible display on restore (see clampOverlayBounds) so a saved off-screen
   * position (monitor unplugged) can't strand the window where it can't be reached.
   */
  overlayBounds: OverlayBounds | null;
  /**
   * EXPERIMENTAL (Phase F): enables the opt-in OCR contract-capture fallback —
   * a screen-capture + tesseract.js pipeline that reads the mobiGlas contract
   * screen to recover SCU / commodity / location / reward when the game
   * suppressed the authoritative New Objective log line. Default false: the
   * capture entry point is HIDDEN unless the user turns this on, because OCR
   * accuracy on the stylized font is unproven. Persisted so the choice survives
   * a restart. NEVER auto-applies anything — the user reviews before any write.
   */
  ocrEnabled: boolean;
}

/** Window rectangle persisted for the overlay (screen coordinates, px). */
export interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The safe default used when no settings file exists or it is unreadable. */
export const DEFAULT_SETTINGS: AppSettings = {
  liveFolder: null,
  mode: "cargo",
  selectedShipSlug: null,
  overlayEnabled: false,
  overlayBounds: null,
  ocrEnabled: false,
};

/** Default overlay size (px) when no bounds are saved — small, glanceable card. */
export const OVERLAY_DEFAULT_SIZE = { width: 340, height: 230 } as const;

/** Minimum overlay size the clamp enforces (keeps the card usable when resized). */
export const OVERLAY_MIN_SIZE = { width: 240, height: 150 } as const;

/** Coerce an arbitrary value to a valid AppMode, defaulting to 'cargo'. */
function normalizeMode(value: unknown): AppMode {
  if (value === "salvage" || value === "mining") return value;
  return "cargo";
}

/** Coerce an arbitrary value to a ship slug or null (empty string -> null). */
function normalizeShipSlug(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Coerce an arbitrary value to a boolean (anything non-true -> false). */
function normalizeBool(value: unknown): boolean {
  return value === true;
}

/**
 * Coerce arbitrary parsed JSON into OverlayBounds or null. Every field must be a
 * finite number and width/height must be positive; otherwise the whole value is
 * dropped to null (a partially-corrupt rect is unusable, so we fall back to the
 * default size rather than open a window at a nonsense rectangle).
 */
function normalizeOverlayBounds(value: unknown): OverlayBounds | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const x = r.x;
  const y = r.y;
  const width = r.width;
  const height = r.height;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no real fs unless you pass it one)
// ---------------------------------------------------------------------------

/** The Game.log path implied by a chosen LIVE folder. */
export function gameLogPathForFolder(liveFolder: string): string {
  return join(liveFolder, "Game.log");
}

/**
 * Validate that a candidate LIVE folder directly contains Game.log. Used by the
 * picker BEFORE saving so we never persist a folder that yields an empty app.
 * `fileExists` is injectable so this predicate is unit-testable.
 */
export function folderHasGameLog(
  liveFolder: string,
  fileExists: (p: string) => boolean = existsSync,
): boolean {
  return fileExists(gameLogPathForFolder(liveFolder));
}

/**
 * Merge a partial update onto a base settings object, normalizing each field.
 * An empty-string liveFolder collapses to null (treat "" as "unset"). Unknown
 * keys on `patch` are ignored — only declared settings survive.
 */
export function mergeSettings(
  base: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  const next: AppSettings = { ...DEFAULT_SETTINGS, ...base };
  // Re-normalize base fields that may have been forged in memory (defensive).
  next.mode = normalizeMode(next.mode);
  next.selectedShipSlug = normalizeShipSlug(next.selectedShipSlug);
  next.overlayEnabled = normalizeBool(next.overlayEnabled);
  next.overlayBounds = normalizeOverlayBounds(next.overlayBounds);
  next.ocrEnabled = normalizeBool(next.ocrEnabled);
  if ("liveFolder" in patch) {
    const v = patch.liveFolder;
    next.liveFolder = typeof v === "string" && v.length > 0 ? v : null;
  }
  if ("mode" in patch) {
    next.mode = normalizeMode(patch.mode);
  }
  if ("selectedShipSlug" in patch) {
    next.selectedShipSlug = normalizeShipSlug(patch.selectedShipSlug);
  }
  if ("overlayEnabled" in patch) {
    next.overlayEnabled = normalizeBool(patch.overlayEnabled);
  }
  if ("overlayBounds" in patch) {
    next.overlayBounds = normalizeOverlayBounds(patch.overlayBounds);
  }
  if ("ocrEnabled" in patch) {
    next.ocrEnabled = normalizeBool(patch.ocrEnabled);
  }
  return next;
}

/**
 * Coerce arbitrary parsed JSON into a valid AppSettings, dropping anything that
 * doesn't match the shape. A corrupt/garbage value yields the defaults.
 */
export function normalizeSettings(parsed: unknown): AppSettings {
  if (parsed === null || typeof parsed !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const raw = parsed as Record<string, unknown>;
  const liveFolder =
    typeof raw.liveFolder === "string" && raw.liveFolder.length > 0
      ? raw.liveFolder
      : null;
  return {
    liveFolder,
    mode: normalizeMode(raw.mode),
    selectedShipSlug: normalizeShipSlug(raw.selectedShipSlug),
    overlayEnabled: normalizeBool(raw.overlayEnabled),
    overlayBounds: normalizeOverlayBounds(raw.overlayBounds),
    ocrEnabled: normalizeBool(raw.ocrEnabled),
  };
}

// ---------------------------------------------------------------------------
// Overlay bounds clamping (Phase D)
// ---------------------------------------------------------------------------

/** A visible display work area, in screen coordinates (Electron Display.workArea). */
export interface DisplayArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clamp a saved overlay rectangle so it is fully visible inside SOME connected
 * display's work area, returning a usable rect to open the window at.
 *
 * Why: a window restored at its last position can end up entirely off-screen if
 * the user unplugged the monitor it was on (or changed resolution). Electron will
 * happily create a window no one can reach. We pick the display the saved rect
 * overlaps most (its center, falling back to the primary/first display), shrink
 * the size to fit that work area (never below OVERLAY_MIN_SIZE), then nudge the
 * origin so the whole rect sits inside. Pure + total — `displays` is injectable
 * so this is unit-testable without Electron's screen module.
 *
 * `bounds === null` (never saved) -> a default-size rect centered in the chosen
 * display, so a first open is sensibly placed too.
 */
export function clampOverlayBounds(
  bounds: OverlayBounds | null,
  displays: DisplayArea[],
  defaultSize: { width: number; height: number } = OVERLAY_DEFAULT_SIZE,
  minSize: { width: number; height: number } = OVERLAY_MIN_SIZE,
): OverlayBounds {
  // No displays reported (shouldn't happen) -> return the requested/default rect
  // unchanged rather than throwing; the OS will place it.
  if (displays.length === 0) {
    if (bounds) return bounds;
    return { x: 0, y: 0, width: defaultSize.width, height: defaultSize.height };
  }

  // Choose the target display: the one whose work area contains the saved rect's
  // center, else the first display (treated as primary).
  const pick = (): DisplayArea => {
    if (bounds) {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const hit = displays.find(
        (d) =>
          cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height,
      );
      if (hit) return hit;
    }
    return displays[0];
  };
  const d = pick();

  // Size: requested (or default), clamped to [minSize, workArea].
  const reqW = bounds?.width ?? defaultSize.width;
  const reqH = bounds?.height ?? defaultSize.height;
  const width = Math.max(minSize.width, Math.min(reqW, d.width));
  const height = Math.max(minSize.height, Math.min(reqH, d.height));

  // Origin: requested (or centered when never saved), then nudged so the whole
  // rect sits inside the work area.
  let x = bounds ? bounds.x : d.x + Math.round((d.width - width) / 2);
  let y = bounds ? bounds.y : d.y + Math.round((d.height - height) / 2);
  x = Math.min(Math.max(x, d.x), d.x + d.width - width);
  y = Math.min(Math.max(y, d.y), d.y + d.height - height);

  return { x: Math.round(x), y: Math.round(y), width, height };
}

/**
 * Resolve the Game.log path the watcher should watch.
 *
 * Rule (SPEC): use `<configured LIVE folder>/Game.log` IFF a folder is configured
 * AND that Game.log is present on disk; otherwise fall back to the default LIVE
 * path. This means a configured-but-now-missing folder (game uninstalled, drive
 * unplugged) degrades gracefully to the default rather than watching a dead path.
 *
 * `fileExists` is injectable for unit testing.
 */
export function resolveGameLogPath(
  settings: AppSettings,
  fileExists: (p: string) => boolean = existsSync,
  defaultPath: string = DEFAULT_GAME_LOG_PATH,
): string {
  if (settings.liveFolder) {
    const candidate = gameLogPathForFolder(settings.liveFolder);
    if (fileExists(candidate)) return candidate;
  }
  return defaultPath;
}

// ---------------------------------------------------------------------------
// Disk I/O (impure — used by main.ts at runtime)
// ---------------------------------------------------------------------------

/** Absolute path to the per-user settings file. */
export function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

/**
 * Load settings from disk. Returns DEFAULT_SETTINGS on a missing or corrupt
 * file (never throws) so the app always boots. A malformed JSON file is left
 * in place (not deleted) — the next successful save() overwrites it cleanly.
 */
export function loadSettings(path: string = settingsPath()): AppSettings {
  try {
    // Strip a leading UTF-8 BOM: a hand-edited file saved by some editors (or
    // Windows PowerShell's default Set-Content) starts with ﻿, which makes
    // JSON.parse throw. Tolerating it keeps a user-edited file working.
    const raw = readFileSync(path, "utf-8").replace(/^﻿/, "");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Merge a patch onto the current on-disk settings and write the result. Reading
 * first means a partial update can never drop an unrelated key. Returns the new
 * merged settings. Creates the userData dir if it somehow doesn't exist yet.
 */
export function saveSettings(
  patch: Partial<AppSettings>,
  path: string = settingsPath(),
): AppSettings {
  const merged = mergeSettings(loadSettings(path), patch);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}
