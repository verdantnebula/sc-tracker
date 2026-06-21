// ============================================================================
// settings.test.ts — per-user settings module
// ----------------------------------------------------------------------------
// Covers the deterministic, fs-light surface:
//   - load/save/merge round-trip on a throwaway temp file (NEVER the live app
//     settings file — see memory: never write the live app state out-of-band).
//   - corrupt-settings fallback to defaults (never throws).
//   - mergeSettings normalization (empty string -> null, unknown keys dropped).
//   - resolveGameLogPath: configured-and-exists vs configured-missing vs unset.
//   - folderHasGameLog predicate (the picker's validate gate).
// The pure helpers take an injectable existence predicate, so the path-resolution
// tests need no real filesystem at all.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  folderHasGameLog,
  gameLogPathForFolder,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  resolveGameLogPath,
  saveSettings,
  type AppSettings,
} from "./settings";
import { DEFAULT_GAME_LOG_PATH } from "./logWatcher";

// --- Temp dir scaffolding (throwaway — never the real userData file) ---------

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-settings-"));
  file = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// load / save / merge round-trip
// ---------------------------------------------------------------------------

describe("loadSettings / saveSettings", () => {
  it("returns defaults when the file does not exist", () => {
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a saved liveFolder", () => {
    const folder = "D:/Games/StarCitizen/LIVE";
    const saved = saveSettings({ liveFolder: folder }, file);
    expect(saved.liveFolder).toBe(folder);
    // Re-read from disk to prove it persisted.
    expect(loadSettings(file).liveFolder).toBe(folder);
  });

  it("writes valid, pretty-printed JSON", () => {
    saveSettings({ liveFolder: "E:/SC/LIVE" }, file);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk).toEqual({ liveFolder: "E:/SC/LIVE" });
  });

  it("merges onto existing on-disk settings (a partial write can't drop keys)", () => {
    saveSettings({ liveFolder: "F:/SC/LIVE" }, file);
    // A save that does NOT touch liveFolder must preserve it.
    const merged = saveSettings({}, file);
    expect(merged.liveFolder).toBe("F:/SC/LIVE");
  });

  it("can clear a previously-set folder by saving null", () => {
    saveSettings({ liveFolder: "G:/SC/LIVE" }, file);
    const cleared = saveSettings({ liveFolder: null }, file);
    expect(cleared.liveFolder).toBeNull();
    expect(loadSettings(file).liveFolder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// corrupt-settings fallback
// ---------------------------------------------------------------------------

describe("corrupt / malformed settings fallback", () => {
  it("returns defaults for invalid JSON (never throws)", () => {
    writeFileSync(file, "{ this is not valid json ", "utf-8");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for a JSON value that is not an object", () => {
    writeFileSync(file, '"just a string"', "utf-8");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("drops a non-string liveFolder", () => {
    writeFileSync(file, JSON.stringify({ liveFolder: 42 }), "utf-8");
    expect(loadSettings(file).liveFolder).toBeNull();
  });

  it("tolerates a leading UTF-8 BOM (hand-edited / PowerShell-saved file)", () => {
    // ﻿ is the BOM; some editors prepend it and it would otherwise make
    // JSON.parse throw, silently dropping the user's setting.
    writeFileSync(
      file,
      "﻿" + JSON.stringify({ liveFolder: "I:/SC/LIVE" }),
      "utf-8",
    );
    expect(loadSettings(file).liveFolder).toBe("I:/SC/LIVE");
  });

  it("saving over a corrupt file repairs it", () => {
    writeFileSync(file, "garbage", "utf-8");
    const saved = saveSettings({ liveFolder: "H:/SC/LIVE" }, file);
    expect(saved.liveFolder).toBe("H:/SC/LIVE");
    expect(loadSettings(file).liveFolder).toBe("H:/SC/LIVE");
  });
});

// ---------------------------------------------------------------------------
// mergeSettings / normalizeSettings normalization
// ---------------------------------------------------------------------------

describe("mergeSettings", () => {
  const base: AppSettings = { liveFolder: "A:/old" };

  it("collapses an empty-string liveFolder to null", () => {
    expect(mergeSettings(base, { liveFolder: "" }).liveFolder).toBeNull();
  });

  it("leaves liveFolder untouched when the patch omits it", () => {
    expect(mergeSettings(base, {}).liveFolder).toBe("A:/old");
  });

  it("ignores unknown keys", () => {
    const merged = mergeSettings(base, {
      bogus: "x",
    } as unknown as Partial<AppSettings>);
    expect(merged).toEqual({ liveFolder: "A:/old" });
  });
});

describe("normalizeSettings", () => {
  it("coerces null/garbage to defaults", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(123)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("str")).toEqual(DEFAULT_SETTINGS);
  });
});

// ---------------------------------------------------------------------------
// folderHasGameLog (the picker's validate gate)
// ---------------------------------------------------------------------------

describe("folderHasGameLog", () => {
  it("is true when <folder>/Game.log exists", () => {
    const exists = (p: string) => p === join("X:/SC/LIVE", "Game.log");
    expect(folderHasGameLog("X:/SC/LIVE", exists)).toBe(true);
  });

  it("is false when Game.log is absent in the folder", () => {
    expect(folderHasGameLog("X:/SC/LIVE", () => false)).toBe(false);
  });

  it("derives the Game.log path under the folder", () => {
    expect(gameLogPathForFolder("X:/SC/LIVE")).toBe(
      join("X:/SC/LIVE", "Game.log"),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveGameLogPath — the core path-resolution rule
// ---------------------------------------------------------------------------

describe("resolveGameLogPath", () => {
  const FALLBACK = DEFAULT_GAME_LOG_PATH;

  it("uses the configured folder's Game.log when it exists", () => {
    const folder = "D:/Games/SC/LIVE";
    const expected = gameLogPathForFolder(folder);
    const exists = (p: string) => p === expected;
    expect(resolveGameLogPath({ liveFolder: folder }, exists)).toBe(expected);
  });

  it("falls back to default when the configured folder's Game.log is missing", () => {
    expect(
      resolveGameLogPath({ liveFolder: "D:/Games/SC/LIVE" }, () => false),
    ).toBe(FALLBACK);
  });

  it("uses the default when no folder is configured (unset)", () => {
    // exists() returns true for everything; with no folder set it must STILL
    // return the default (the unset branch never consults the predicate).
    expect(resolveGameLogPath({ liveFolder: null }, () => true)).toBe(FALLBACK);
  });

  it("honors a custom default path argument", () => {
    const custom = "Z:/custom/Game.log";
    expect(resolveGameLogPath({ liveFolder: null }, () => true, custom)).toBe(
      custom,
    );
  });
});
