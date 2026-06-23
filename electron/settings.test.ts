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
  clampOverlayBounds,
  DEFAULT_SETTINGS,
  folderHasGameLog,
  gameLogPathForFolder,
  loadSettings,
  mergeSettings,
  normalizeSettings,
  OVERLAY_DEFAULT_SIZE,
  OVERLAY_MIN_SIZE,
  resolveGameLogPath,
  saveSettings,
  type AppSettings,
  type DisplayArea,
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
    expect(onDisk).toEqual({
      liveFolder: "E:/SC/LIVE",
      mode: "cargo",
      selectedShipSlug: null,
      overlayEnabled: false,
      overlayBounds: null,
    });
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
// mode (cargo / salvage) persistence — the Phase-1 salvage-mode switch
// ---------------------------------------------------------------------------

describe("app mode persistence", () => {
  it("defaults to cargo when the file does not exist", () => {
    expect(loadSettings(file).mode).toBe("cargo");
    expect(DEFAULT_SETTINGS.mode).toBe("cargo");
  });

  it("round-trips a saved salvage mode", () => {
    const saved = saveSettings({ mode: "salvage" }, file);
    expect(saved.mode).toBe("salvage");
    // Re-read from disk to prove it persisted across a (simulated) restart.
    expect(loadSettings(file).mode).toBe("salvage");
  });

  it("can switch back to cargo", () => {
    saveSettings({ mode: "salvage" }, file);
    const back = saveSettings({ mode: "cargo" }, file);
    expect(back.mode).toBe("cargo");
    expect(loadSettings(file).mode).toBe("cargo");
  });

  it("preserves liveFolder when only the mode changes (and vice versa)", () => {
    saveSettings({ liveFolder: "D:/SC/LIVE" }, file);
    const merged = saveSettings({ mode: "salvage" }, file);
    expect(merged.liveFolder).toBe("D:/SC/LIVE");
    expect(merged.mode).toBe("salvage");
    // ...and changing the folder must not reset the mode.
    const merged2 = saveSettings({ liveFolder: "E:/SC/LIVE" }, file);
    expect(merged2.mode).toBe("salvage");
  });

  it("falls back to cargo for a corrupt/unknown mode value", () => {
    writeFileSync(file, JSON.stringify({ mode: "wormhole" }), "utf-8");
    expect(loadSettings(file).mode).toBe("cargo");
    writeFileSync(file, JSON.stringify({ mode: 42 }), "utf-8");
    expect(loadSettings(file).mode).toBe("cargo");
  });

  it("falls back to cargo for an invalid-JSON file (never throws)", () => {
    writeFileSync(file, "{ not json ", "utf-8");
    expect(loadSettings(file).mode).toBe("cargo");
  });

  it("collapses an unknown mode in a merge patch to cargo", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      mode: "bogus",
    } as unknown as Partial<AppSettings>);
    expect(merged.mode).toBe("cargo");
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
  const base: AppSettings = {
    liveFolder: "A:/old",
    mode: "cargo",
    selectedShipSlug: null,
    overlayEnabled: false,
    overlayBounds: null,
  };

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
    expect(merged).toEqual({
      liveFolder: "A:/old",
      mode: "cargo",
      selectedShipSlug: null,
      overlayEnabled: false,
      overlayBounds: null,
    });
  });
});

// ---------------------------------------------------------------------------
// selectedShipSlug (Phase A ship picker) persistence
// ---------------------------------------------------------------------------

describe("selected ship persistence", () => {
  it("defaults to null when the file does not exist", () => {
    expect(loadSettings(file).selectedShipSlug).toBeNull();
    expect(DEFAULT_SETTINGS.selectedShipSlug).toBeNull();
  });

  it("round-trips a saved ship slug", () => {
    const saved = saveSettings({ selectedShipSlug: "hull-c" }, file);
    expect(saved.selectedShipSlug).toBe("hull-c");
    // Re-read from disk to prove it persisted across a (simulated) restart.
    expect(loadSettings(file).selectedShipSlug).toBe("hull-c");
  });

  it("can clear a previously-set ship by saving null", () => {
    saveSettings({ selectedShipSlug: "caterpillar" }, file);
    const cleared = saveSettings({ selectedShipSlug: null }, file);
    expect(cleared.selectedShipSlug).toBeNull();
    expect(loadSettings(file).selectedShipSlug).toBeNull();
  });

  it("collapses an empty-string slug to null", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { selectedShipSlug: "" });
    expect(merged.selectedShipSlug).toBeNull();
  });

  it("drops a non-string slug from a corrupt file", () => {
    writeFileSync(file, JSON.stringify({ selectedShipSlug: 42 }), "utf-8");
    expect(loadSettings(file).selectedShipSlug).toBeNull();
  });

  it("preserves mode + liveFolder when only the ship changes", () => {
    saveSettings({ liveFolder: "D:/SC/LIVE", mode: "salvage" }, file);
    const merged = saveSettings({ selectedShipSlug: "hull-e" }, file);
    expect(merged.liveFolder).toBe("D:/SC/LIVE");
    expect(merged.mode).toBe("salvage");
    expect(merged.selectedShipSlug).toBe("hull-e");
    // ...and changing the ship again must not reset mode/liveFolder.
    const merged2 = saveSettings({ selectedShipSlug: "hull-c" }, file);
    expect(merged2.mode).toBe("salvage");
    expect(merged2.liveFolder).toBe("D:/SC/LIVE");
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
    expect(
      resolveGameLogPath(
        {
          liveFolder: folder,
          mode: "cargo",
          selectedShipSlug: null,
          overlayEnabled: false,
          overlayBounds: null,
        },
        exists,
      ),
    ).toBe(expected);
  });

  it("falls back to default when the configured folder's Game.log is missing", () => {
    expect(
      resolveGameLogPath(
        {
          liveFolder: "D:/Games/SC/LIVE",
          mode: "cargo",
          selectedShipSlug: null,
          overlayEnabled: false,
          overlayBounds: null,
        },
        () => false,
      ),
    ).toBe(FALLBACK);
  });

  it("uses the default when no folder is configured (unset)", () => {
    // exists() returns true for everything; with no folder set it must STILL
    // return the default (the unset branch never consults the predicate).
    expect(
      resolveGameLogPath(
        {
          liveFolder: null,
          mode: "cargo",
          selectedShipSlug: null,
          overlayEnabled: false,
          overlayBounds: null,
        },
        () => true,
      ),
    ).toBe(FALLBACK);
  });

  it("honors a custom default path argument", () => {
    const custom = "Z:/custom/Game.log";
    expect(
      resolveGameLogPath(
        {
          liveFolder: null,
          mode: "cargo",
          selectedShipSlug: null,
          overlayEnabled: false,
          overlayBounds: null,
        },
        () => true,
        custom,
      ),
    ).toBe(custom);
  });
});

// ---------------------------------------------------------------------------
// Overlay window persistence (Phase D) — overlayEnabled + overlayBounds
// ---------------------------------------------------------------------------

describe("overlay settings persistence", () => {
  it("defaults to disabled with no saved bounds", () => {
    expect(DEFAULT_SETTINGS.overlayEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.overlayBounds).toBeNull();
    expect(loadSettings(file).overlayEnabled).toBe(false);
    expect(loadSettings(file).overlayBounds).toBeNull();
  });

  it("round-trips overlayEnabled across a (simulated) restart", () => {
    const saved = saveSettings({ overlayEnabled: true }, file);
    expect(saved.overlayEnabled).toBe(true);
    expect(loadSettings(file).overlayEnabled).toBe(true);
  });

  it("round-trips overlayBounds", () => {
    const bounds = { x: 100, y: 200, width: 340, height: 230 };
    const saved = saveSettings({ overlayBounds: bounds }, file);
    expect(saved.overlayBounds).toEqual(bounds);
    expect(loadSettings(file).overlayBounds).toEqual(bounds);
  });

  it("rounds fractional bounds to integers", () => {
    const saved = saveSettings(
      { overlayBounds: { x: 10.6, y: 20.2, width: 340.9, height: 230.1 } },
      file,
    );
    expect(saved.overlayBounds).toEqual({
      x: 11,
      y: 20,
      width: 341,
      height: 230,
    });
  });

  it("drops a partially-corrupt bounds object to null", () => {
    writeFileSync(
      file,
      JSON.stringify({ overlayBounds: { x: 10, y: 20, width: 340 } }),
      "utf-8",
    );
    expect(loadSettings(file).overlayBounds).toBeNull();
  });

  it("drops bounds with non-positive size to null", () => {
    writeFileSync(
      file,
      JSON.stringify({ overlayBounds: { x: 0, y: 0, width: 0, height: 230 } }),
      "utf-8",
    );
    expect(loadSettings(file).overlayBounds).toBeNull();
  });

  it("coerces a non-boolean overlayEnabled to false", () => {
    writeFileSync(file, JSON.stringify({ overlayEnabled: "yes" }), "utf-8");
    expect(loadSettings(file).overlayEnabled).toBe(false);
  });

  it("preserves overlay settings when an unrelated key is saved", () => {
    saveSettings({ overlayEnabled: true }, file);
    const merged = saveSettings({ liveFolder: "D:/SC/LIVE" }, file);
    expect(merged.overlayEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clampOverlayBounds — keep the restored overlay on a visible display
// ---------------------------------------------------------------------------

describe("clampOverlayBounds", () => {
  // A single 1920x1080 primary display at the origin.
  const primary: DisplayArea = { x: 0, y: 0, width: 1920, height: 1080 };
  // A secondary display to the right (e.g. a second monitor).
  const secondary: DisplayArea = { x: 1920, y: 0, width: 1920, height: 1080 };

  it("returns a fully-on-screen rect unchanged", () => {
    const b = { x: 100, y: 100, width: 340, height: 230 };
    expect(clampOverlayBounds(b, [primary])).toEqual(b);
  });

  it("centers a default-size rect when no bounds were saved", () => {
    const r = clampOverlayBounds(null, [primary]);
    expect(r.width).toBe(OVERLAY_DEFAULT_SIZE.width);
    expect(r.height).toBe(OVERLAY_DEFAULT_SIZE.height);
    expect(r.x).toBe(Math.round((1920 - OVERLAY_DEFAULT_SIZE.width) / 2));
    expect(r.y).toBe(Math.round((1080 - OVERLAY_DEFAULT_SIZE.height) / 2));
  });

  it("nudges an off-the-right-edge rect back inside", () => {
    const b = { x: 1900, y: 100, width: 340, height: 230 };
    const r = clampOverlayBounds(b, [primary]);
    expect(r.x).toBe(1920 - 340); // pushed left so the whole width fits
    expect(r.y).toBe(100);
    expect(r.width).toBe(340);
  });

  it("nudges a negative origin back to the work-area edge", () => {
    const b = { x: -50, y: -80, width: 340, height: 230 };
    const r = clampOverlayBounds(b, [primary]);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("relocates a rect on a now-disconnected monitor onto the primary display", () => {
    // Saved on the secondary monitor, but only the primary is connected now.
    const b = { x: 2200, y: 300, width: 340, height: 230 };
    const r = clampOverlayBounds(b, [primary]);
    // Center was on the (gone) secondary -> falls back to first display, then
    // the off-screen x is clamped into the primary work area.
    expect(r.x).toBeLessThanOrEqual(1920 - 340);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBe(300);
  });

  it("keeps a rect on the display whose work area holds its center", () => {
    const b = { x: 2000, y: 100, width: 340, height: 230 };
    const r = clampOverlayBounds(b, [primary, secondary]);
    // Center (2170, 215) is inside the secondary -> stays there, unchanged.
    expect(r).toEqual(b);
  });

  it("shrinks a rect larger than the work area to fit (>= min size)", () => {
    const tiny: DisplayArea = { x: 0, y: 0, width: 300, height: 200 };
    const b = { x: 0, y: 0, width: 9999, height: 9999 };
    const r = clampOverlayBounds(b, [tiny]);
    expect(r.width).toBe(300);
    expect(r.height).toBe(200);
    expect(r.width).toBeGreaterThanOrEqual(OVERLAY_MIN_SIZE.width);
    expect(r.height).toBeGreaterThanOrEqual(OVERLAY_MIN_SIZE.height);
  });

  it("falls back to the requested/default rect when no displays are reported", () => {
    const b = { x: 50, y: 60, width: 340, height: 230 };
    expect(clampOverlayBounds(b, [])).toEqual(b);
    const d = clampOverlayBounds(null, []);
    expect(d.width).toBe(OVERLAY_DEFAULT_SIZE.width);
    expect(d.height).toBe(OVERLAY_DEFAULT_SIZE.height);
  });
});
