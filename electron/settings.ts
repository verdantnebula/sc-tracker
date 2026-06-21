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
}

/** The safe default used when no settings file exists or it is unreadable. */
export const DEFAULT_SETTINGS: AppSettings = {
  liveFolder: null,
};

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
  if ("liveFolder" in patch) {
    const v = patch.liveFolder;
    next.liveFolder = typeof v === "string" && v.length > 0 ? v : null;
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
  return { liveFolder };
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
