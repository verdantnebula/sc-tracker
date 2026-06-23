// ============================================================================
// main.ts — Electron main process: lifecycle, window, IPC wiring  (SPEC §3, §6)
// ----------------------------------------------------------------------------
// PHASE-3 INTEGRATION. Wires the four implementation modules together:
//
//   logWatcher ──DomainEvent──▶ missionStore.applyEvent ──▶ broadcast mission:list
//        │                                                       (missions:changed)
//        ├─ backfill progress ──▶ backfill:progress (push)
//        └─ connection status ──▶ log:status:changed (push)
//   locationInventory events ──▶ currentLocation (derived) ──▶ currentLocation:changed
//   uexClient ──▶ ref:get (bundled local snapshot; no network, no token)
//
// The channel names + return shapes are fixed by the shared contract
// (src/shared/ipc.ts) and MUST NOT change here. Renderer talks only via the
// typed window.api preload bridge; all fs/network stays in this process.
// ============================================================================

import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  screen,
  desktopCapturer,
} from "electron";
import { join } from "node:path";
import { userInfo } from "node:os";
import { IPC } from "@shared/ipc";
import type {
  Mission,
  ReferenceData,
  LogStatus,
  ManualMissionInput,
  MissionPatch,
  LogPathInfo,
  PickLogFolderResult,
  OcrCaptureResult,
  OcrRecognizeResult,
  AppMode,
  OverlayState,
  SalvageRun,
  SalvageRunInput,
  SalvageRunPatch,
  StrippedComponentInput,
  StrippedComponentPatch,
  SalvageReferenceData,
} from "@shared/types";
import type { DomainEvent } from "@shared/events";
import {
  openMissionStore,
  DatabaseRecoveredError,
  type MissionStore,
  type CaptureEntry,
} from "./missionStore";
import { openSalvageStore, type SalvageStore } from "./salvageStore";
import {
  createSalvageReference,
  type SalvageReferenceLoader,
} from "./salvageReference";
import { isCorruptionError } from "./db/recovery";
import { CurrentLocationTracker } from "./currentLocation";
import { createUexClient, type UexClient } from "./uexClient";
import {
  createLogWatcher,
  type LogWatcher,
  type EventSource,
  DEFAULT_GAME_LOG_PATH,
} from "./logWatcher";
import {
  loadSettings,
  saveSettings,
  resolveGameLogPath,
  folderHasGameLog,
  gameLogPathForFolder,
  clampOverlayBounds,
  DEFAULT_SETTINGS,
  type AppSettings,
  type OverlayBounds,
  type DisplayArea,
} from "./settings";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { installConsoleLogger, buildAppInfo, writeAppInfo } from "./logger";
import { buildDiagnosticsReport } from "./diagnosticsExport";
import { ocrAssetDir, recognize as recognizeOcr } from "./ocrRecognize";
import type { ExportReportResult } from "@shared/types";

// ---------------------------------------------------------------------------
// Process-wide singletons, created on app-ready (need app.getPath('userData')).
// ---------------------------------------------------------------------------

let store: MissionStore | null = null;
let uex: UexClient | null = null;
let watcher: LogWatcher | null = null;
let mainWindow: BrowserWindow | null = null;
// The single always-on-top "next stop" overlay window (Phase D). null when not
// open. Toggled from the main app; its open state + last bounds persist in
// settings so it can be restored on the next launch.
let overlayWindow: BrowserWindow | null = null;
// Debounce timer for persisting overlay bounds on move/resize (a drag fires many
// 'move' events; we only want to write the final rectangle).
let overlayBoundsSaveTimer: NodeJS.Timeout | null = null;

// Salvage tracker singletons (separate domain; own store + bundled reference).
let salvage: SalvageStore | null = null;
let salvageRef: SalvageReferenceLoader | null = null;

// Per-user settings (custom LIVE folder, etc.), loaded on boot. Held in memory
// so the IPC handlers can report/resolve the current Game.log path without a disk
// read each call; saveSettings() still merges onto disk as the source of truth.
let settings: AppSettings = { ...DEFAULT_SETTINGS };

// Latest UEX cache state, threaded into LogStatus.uexActive.
let uexActive = false;

// Last LogStatus seen from the watcher, so a fresh log:status invoke is accurate.
let lastLogStatus: LogStatus = {
  state: "searching",
  logPath: null,
  uexActive: false,
};

// Derived current location. ONLY the latest LIVE RequestLocationInventory wins;
// historical (backfill) observations describe a PAST session and are ignored, so
// the chip never shows a stale/guessed value (null -> "—" until a live terminal
// visit this session). The internal zone id is humanized best-effort for display
// and the "YOU ARE HERE" highlight. See electron/currentLocation.ts.
const locationTracker = new CurrentLocationTracker();

// ---------------------------------------------------------------------------
// Push helpers — broadcast to every renderer window.
// ---------------------------------------------------------------------------

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// Coalesce a burst of applyEvent() calls (backfill pours thousands) into a
// single mission:list push per tick — the renderer only needs the latest list.
let missionsDirty = false;
let missionsFlushQueued = false;

function markMissionsChanged(): void {
  missionsDirty = true;
  if (missionsFlushQueued) return;
  missionsFlushQueued = true;
  setImmediate(flushMissions);
}

function flushMissions(): void {
  missionsFlushQueued = false;
  if (!missionsDirty || !store) return;
  missionsDirty = false;
  // This was the original crash site (flushMissions -> listMissions -> legsFor
  // on a corrupt db threw SQLITE_CORRUPT to a fatal dialog). guard() recovers +
  // rebuilds instead; on recovery we skip this stale broadcast (the rebuild's
  // own markMissionsChanged will re-fire once the fresh db is repopulated).
  try {
    broadcast(
      IPC.MISSIONS_CHANGED,
      store.guard(() => store!.listMissions()),
    );
  } catch (err) {
    if (err instanceof DatabaseRecoveredError) {
      console.warn(
        "[main] database recovered during flush; quarantined to:",
        err.quarantinedTo,
      );
      void rebuildAfterRecovery();
      return;
    }
    console.error("[main] flushMissions failed:", err);
  }
}

// ---------------------------------------------------------------------------
// currentLocation broadcast helper. The derivation + humanize/ignore-historical
// rules live in CurrentLocationTracker; here we just push changes to renderers.
// ---------------------------------------------------------------------------

function resetCurrentLocation(): void {
  locationTracker.reset();
  broadcast(IPC.CURRENT_LOCATION_CHANGED, null);
}

// ---------------------------------------------------------------------------
// The event sink: store-apply every DomainEvent, derive currentLocation, and
// schedule a mission:list broadcast. locationInventory is the only event the
// store ignores (transient), so we handle it here.
// ---------------------------------------------------------------------------

/**
 * Parser-side capture trace: log one concise `[capture]` line per lifecycle-
 * defining domain event, mirrored into main.log by the file logger. Deliberately
 * narrow — only accepted / marker / objective / ended carry diagnostic weight; the
 * high-frequency locationInventory + payout/fine lines are skipped to avoid spam.
 * Fully guarded (a diagnostics aid must never break the tail).
 */
function logCaptureForEvent(event: DomainEvent, source: EventSource): void {
  try {
    switch (event.type) {
      case "missionAccepted":
        console.log(
          `[capture] accepted mission ${event.missionId} "${event.title}" (${source})`,
        );
        return;
      case "missionMarker":
        console.log(
          `[capture] marker mission ${event.missionId} objective ${event.objectiveId} (${event.kind})`,
        );
        return;
      case "objectiveDeclared":
        console.log(
          `[capture] objective mission ${event.missionId} ${event.objectiveId} ${event.scuTotal} SCU ${event.commodity} -> ${event.location}`,
        );
        return;
      case "objectiveCompleted":
        console.log(
          `[capture] objective-complete mission ${event.missionId} ${event.objectiveId}`,
        );
        return;
      case "missionEnded":
        console.log(
          `[capture] ended mission ${event.missionId} (${event.completionType})`,
        );
        return;
      default:
        // payoutAwarded / fined / locationInventory: not lifecycle-defining for
        // the "accepted vs stored" comparison — skip to keep the log readable.
        return;
    }
  } catch {
    /* never break the tail for a log line */
  }
}

/**
 * Store-side capture trace: the store reports add / update / skip decisions here
 * (wired via openMissionStore's onCapture). Pairs with logCaptureForEvent so a
 * drop is visible as `added` for the stored mission and `skipped (reason …)` for
 * the rest. Guarded by the store already; we just format the line.
 */
function logStoreCapture(entry: CaptureEntry): void {
  try {
    if (entry.kind === "skipped") {
      console.log(
        `[capture] store: skipped ${entry.what} ${entry.missionId} (reason: ${entry.reason ?? "unknown"})`,
      );
    } else {
      console.log(
        `[capture] store: ${entry.kind} ${entry.what} ${entry.missionId}`,
      );
    }
  } catch {
    /* never break the tail for a log line */
  }
}

function onDomainEvent(event: DomainEvent, source: EventSource): void {
  if (event.type === "locationInventory") {
    // Only LIVE observations update the current location; historical backfill
    // ones (a PAST session) are ignored by the tracker. Broadcast on change.
    if (locationTracker.apply(event.locationId, source)) {
      broadcast(IPC.CURRENT_LOCATION_CHANGED, locationTracker.get());
    }
    // The store deliberately no-ops on this; nothing else to do.
    return;
  }
  if (!store) return;
  // Capture-trace (parser side): a concise line per meaningful mission event so
  // that, for a "5 accepted, 1 stored" bug, main.log shows 5 `[capture] accepted`
  // lines and the store side shows 1 `added` + 4 `skipped`. Guarded so it never
  // throws; only the lifecycle-defining events are logged (no per-noise-line spam).
  logCaptureForEvent(event, source);
  try {
    // guard() recovers-and-rebuilds (then rethrows DatabaseRecoveredError) if a
    // SQLITE_CORRUPT is thrown mid-apply, so a corrupt db rebuilds instead of
    // bubbling to a fatal uncaughtException dialog.
    store.guard(() => store!.applyEvent(event, source));
    markMissionsChanged();
  } catch (err) {
    if (err instanceof DatabaseRecoveredError) {
      // The db was corrupt and has been rebuilt fresh. Repopulate from logs.
      console.warn(
        "[main] database recovered mid-apply; quarantined to:",
        err.quarantinedTo,
      );
      void rebuildAfterRecovery();
      return;
    }
    // A single bad event must never kill the tail (defensive, SPEC §2 ⚠).
    console.error("[main] applyEvent failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Recovery rebuild: after the store recreated a fresh (empty) db following a
// corruption, repopulate it from the logs (logbackups backfill + the live read
// already happened, but the fresh db lost them — re-run backfill). currentLocation
// is reset because backfill is historical-only and won't re-derive it.
// ---------------------------------------------------------------------------

let rebuildInFlight = false;

async function rebuildAfterRecovery(): Promise<void> {
  if (rebuildInFlight) return;
  rebuildInFlight = true;
  try {
    resetCurrentLocation();
    if (watcher) {
      await watcher.backfill();
    }
    markMissionsChanged();
  } catch (err) {
    console.error("[main] rebuild after recovery failed:", err);
  } finally {
    rebuildInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Watcher lifecycle — create, (re)start, and cleanly retarget the log watcher.
// ----------------------------------------------------------------------------
// Pulled out of boot() so the settings picker can retarget the watcher at a new
// LIVE folder at runtime: stop the old chokidar handle cleanly, create a fresh
// watcher on the new path, and re-run backfill. The event sink (onDomainEvent)
// and onStatus/onBackfillProgress callbacks are stable references, so swapping
// the watcher never double-attaches listeners — each watcher owns exactly one
// chokidar FSWatcher and disposes it on stop().
// ---------------------------------------------------------------------------

/** Resolve the Game.log path from current settings (configured-and-exists else default). */
function resolvedLogPath(): string {
  // Env override still wins for testing/dev, matching the original boot().
  return (
    process.env["SC_GAME_LOG_PATH"] ??
    resolveGameLogPath(settings, existsSync, DEFAULT_GAME_LOG_PATH)
  );
}

/** Build the LogPathInfo view model the settings UI renders. */
function buildLogPathInfo(): LogPathInfo {
  const gameLogPath = resolvedLogPath();
  return {
    liveFolder: settings.liveFolder,
    gameLogPath,
    isDefault: settings.liveFolder === null,
    gameLogExists: existsSync(gameLogPath),
  };
}

/**
 * Create a watcher for `logPath`, wire it to the stable sinks, and start it
 * (backfill + live tail). The previous watcher (if any) is stopped + disposed
 * FIRST so there is never more than one chokidar handle on disk. start() is not
 * awaited inside (the window is already up); callers that need the backfill to
 * finish before reporting status await the returned promise.
 */
async function startWatcher(logPath: string): Promise<void> {
  // Tear down the existing watcher cleanly before creating a new one.
  if (watcher) {
    try {
      await watcher.stop();
    } catch (err) {
      console.error("[main] failed to stop previous watcher:", err);
    }
    watcher = null;
  }

  // Useful for support: which Game.log did we resolve to (default vs custom)?
  console.log("[main] watching Game.log at:", logPath);

  watcher = createLogWatcher({
    logPath,
    onEvent: onDomainEvent,
    onStatus: (status) => {
      lastLogStatus = status;
      broadcast(IPC.LOG_STATUS_CHANGED, { ...status, uexActive });
    },
    onBackfillProgress: (progress) =>
      broadcast(IPC.BACKFILL_PROGRESS, progress),
    uexActive,
  });

  await watcher.start();
  markMissionsChanged();
}

/**
 * Retarget the watcher at a new LIVE folder chosen via the picker (or a typed
 * path). Validates Game.log is present in the folder, persists the setting,
 * wipes stale current-session state, and restarts the watcher against the new
 * path — re-backfilling its logbackups sibling. Returns a PickLogFolderResult
 * the renderer surfaces (error toast on a folder with no Game.log; nothing is
 * saved or restarted in that case).
 */
async function applyLiveFolder(
  liveFolder: string,
): Promise<PickLogFolderResult> {
  if (!folderHasGameLog(liveFolder, existsSync)) {
    return {
      outcome: "error",
      error: `No Game.log found in:\n${liveFolder}\n\nPick the StarCitizen \\LIVE\\ folder that contains Game.log.`,
    };
  }

  // Persist first (merge onto disk), then update the in-memory copy.
  settings = saveSettings({ liveFolder });

  // The new install is a different session: the current-location chip and the
  // active set were derived from the OLD log. Reset location; the restart's
  // backfill + live read repopulate missions. (The store's applyEvent is
  // idempotent, so a re-read of overlapping content can't double-apply.)
  resetCurrentLocation();

  await startWatcher(gameLogPathForFolder(liveFolder));

  return { outcome: "ok", info: buildLogPathInfo() };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#04070a",
    autoHideMenuBar: true,
    title: "SC Cargo Tracker",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // The overlay is a secondary window; when the MAIN window closes the app is
    // shutting down, so tear the overlay down too. Otherwise it would keep the
    // process alive (window-all-closed never fires) with no way to reach it.
    destroyOverlay();
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// ---------------------------------------------------------------------------
// Overlay window (Phase D) — frameless, always-on-top, transparent "next stop"
// card that floats over the game. Single instance; reuses the SAME preload as the
// main window (so its renderer gets the identical typed window.api). Closing it
// never touches the main window; it closes with the app.
//
// CAVEAT: true exclusive-fullscreen games can paint over an always-on-top window.
// We recommend Borderless/Windowed in SC (noted in the release notes + UI).
// ---------------------------------------------------------------------------

/** Current connected displays as plain work-area rects for clampOverlayBounds. */
function displayAreas(): DisplayArea[] {
  try {
    return screen.getAllDisplays().map((d) => ({
      x: d.workArea.x,
      y: d.workArea.y,
      width: d.workArea.width,
      height: d.workArea.height,
    }));
  } catch {
    // screen is unavailable before app 'ready' or in a headless context; the
    // clamp helper treats an empty list as "use the saved/default rect as-is".
    return [];
  }
}

/** The overlay's open/closed state for IPC + the main window's pin button. */
function overlayState(): OverlayState {
  return { enabled: overlayWindow !== null && !overlayWindow.isDestroyed() };
}

/** Push the overlay state to every renderer so the TopBar pin stays in sync. */
function broadcastOverlayState(): void {
  broadcast(IPC.OVERLAY_STATE_CHANGED, overlayState());
}

/** Persist the overlay's current bounds (debounced). Guarded — never throws. */
function scheduleOverlayBoundsSave(): void {
  if (overlayBoundsSaveTimer) clearTimeout(overlayBoundsSaveTimer);
  overlayBoundsSaveTimer = setTimeout(() => {
    overlayBoundsSaveTimer = null;
    try {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      const b = overlayWindow.getBounds();
      const bounds: OverlayBounds = {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
      };
      settings = saveSettings({ overlayBounds: bounds });
    } catch (err) {
      console.error("[main] overlay bounds save failed:", err);
    }
  }, 400);
}

/**
 * Create + show the overlay window. Restores the last bounds (clamped to a
 * currently-visible display so a saved off-screen rect can't strand it), wires
 * move/resize persistence, and reports state changes. No-op if already open.
 */
function createOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    overlayWindow.focus();
    return;
  }

  const bounds = clampOverlayBounds(settings.overlayBounds, displayAreas());

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 240,
    minHeight: 150,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    title: "SC Cargo Tracker — Next Stop",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  overlayWindow = win;
  // Float above normal always-on-top windows; this is the strongest level we can
  // request short of beating an exclusive-fullscreen game (documented caveat).
  win.setAlwaysOnTop(true, "screen-saver");
  // Keep the overlay visible across virtual desktops / fullscreen spaces.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.once("ready-to-show", () => win.show());
  win.on("move", scheduleOverlayBoundsSave);
  win.on("resize", scheduleOverlayBoundsSave);
  win.on("closed", () => {
    if (overlayWindow === win) overlayWindow = null;
    // The 'closed' here is the app shutting the window (toggle/quit). State is
    // broadcast by the caller that initiated the close so we don't double-fire.
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(`${devUrl}/overlay.html`);
  } else {
    void win.loadFile(join(__dirname, "../renderer/overlay.html"));
  }
}

/** Close the overlay window if open (used by toggle + before-quit). */
function destroyOverlay(): void {
  if (overlayBoundsSaveTimer) {
    clearTimeout(overlayBoundsSaveTimer);
    overlayBoundsSaveTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}

/**
 * Toggle the overlay open/closed, persist the new `overlayEnabled` choice, and
 * broadcast the resulting state to the main window's pin button. Returns the
 * resulting state for the invoking renderer.
 */
function toggleOverlay(): OverlayState {
  const open = overlayWindow !== null && !overlayWindow.isDestroyed();
  if (open) {
    destroyOverlay();
    settings = saveSettings({ overlayEnabled: false });
  } else {
    createOverlay();
    settings = saveSettings({ overlayEnabled: true });
  }
  const state = overlayState();
  broadcastOverlayState();
  return state;
}

// ---------------------------------------------------------------------------
// IPC handlers — backed by the real store / uexClient / watcher.
// ---------------------------------------------------------------------------

// Run a store read guarded against corruption: on a SQLITE_CORRUPT the store
// recovers-and-rebuilds, we kick a backfill, and return `fallback` for this call
// (the rebuild re-broadcasts the fresh list shortly). Keeps IPC reads from ever
// throwing a fatal error to the renderer / main process.
function safeRead<T>(fn: () => T, fallback: T): T {
  if (!store) return fallback;
  try {
    return store.guard(fn);
  } catch (err) {
    if (err instanceof DatabaseRecoveredError) {
      console.warn(
        "[main] database recovered during read; quarantined to:",
        err.quarantinedTo,
      );
      void rebuildAfterRecovery();
      return fallback;
    }
    throw err;
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.MISSION_LIST, (): Mission[] =>
    safeRead(() => store!.listMissions(), []),
  );

  ipcMain.handle(IPC.MISSION_ACTIVE, (): Mission[] =>
    safeRead(() => store!.activeMissions(), []),
  );

  ipcMain.handle(IPC.MISSION_ADD, (_e, input: ManualMissionInput): Mission => {
    if (!store) throw new Error("store not ready");
    const mission = store.addManualMission(input);
    markMissionsChanged();
    return mission;
  });

  ipcMain.handle(
    IPC.MISSION_UPDATE,
    (_e, id: string, patch: MissionPatch): Mission => {
      if (!store) throw new Error("store not ready");
      const mission = store.updateMission(id, patch);
      markMissionsChanged();
      return mission;
    },
  );

  ipcMain.handle(IPC.MISSION_ABANDON, (_e, id: string): void => {
    if (!store) return;
    // The renderer's "abandon" action is a hard delete per the store contract
    // (MISSION_ABANDON -> void). Mark-as-abandoned (terminal status) is reached
    // via MISSION_UPDATE { status: 'abandoned' } from the detail panel instead.
    store.abandonMission(id);
    markMissionsChanged();
  });

  ipcMain.handle(IPC.MISSION_CLEAR_ACTIVE, (): number => {
    if (!store) return 0;
    const removed = store.clearActiveMissions();
    // Clearing the active session also clears the current-location context.
    resetCurrentLocation();
    markMissionsChanged();
    return removed;
  });

  ipcMain.handle(IPC.DATA_RESET, async (): Promise<number> => {
    if (!store) return 0;
    // Wipe everything, then re-run the logbackups backfill under the corrected
    // (historical) rules so History is rebuilt clean and the active list starts
    // empty (until the live tail re-observes current-session missions). Reset
    // currentLocation too — backfill is historical-only and won't re-derive it.
    const removed = store.resetAllData();
    resetCurrentLocation();
    markMissionsChanged();
    if (watcher) {
      await watcher.backfill();
      markMissionsChanged();
    }
    return removed;
  });

  ipcMain.handle(IPC.REF_GET, (): ReferenceData => {
    if (!uex) return { commodities: [], terminals: [], ships: [] };
    return uex.getReferenceData();
  });

  ipcMain.handle(IPC.LOG_STATUS, (): LogStatus => {
    // Prefer the watcher's live snapshot; fall back to the last pushed status.
    const base = watcher ? watcher.status() : lastLogStatus;
    return { ...base, uexActive };
  });

  ipcMain.handle(IPC.CURRENT_LOCATION_GET, (): string | null =>
    locationTracker.get(),
  );

  ipcMain.handle(IPC.BACKFILL_START, async (): Promise<void> => {
    if (!watcher) return;
    await watcher.backfill();
    markMissionsChanged();
  });

  // --- Custom LIVE-folder settings ----------------------------------------

  ipcMain.handle(
    IPC.SETTINGS_GET_LOG_PATH,
    (): LogPathInfo => buildLogPathInfo(),
  );

  ipcMain.handle(
    IPC.SETTINGS_PICK_LOG_FOLDER,
    async (): Promise<PickLogFolderResult> => {
      // Default the dialog to the existing SC dir when it's present, else the
      // directory the watcher is currently using, so the user starts near home.
      const current = resolvedLogPath();
      const defaultPath = existsSync(DEFAULT_GAME_LOG_PATH)
        ? dirname(DEFAULT_GAME_LOG_PATH)
        : existsSync(current)
          ? dirname(current)
          : undefined;

      let result: Electron.OpenDialogReturnValue;
      try {
        const opts: Electron.OpenDialogOptions = {
          title: "Select your StarCitizen \\LIVE\\ folder",
          properties: ["openDirectory"],
          ...(defaultPath ? { defaultPath } : {}),
        };
        result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, opts)
          : await dialog.showOpenDialog(opts);
      } catch (err) {
        console.error("[main] folder picker failed:", err);
        return { outcome: "error", error: "Could not open the folder picker." };
      }

      if (result.canceled || result.filePaths.length === 0) {
        return { outcome: "canceled" };
      }
      return applyLiveFolder(result.filePaths[0]);
    },
  );

  ipcMain.handle(
    IPC.SETTINGS_SET_LOG_PATH,
    async (_e, liveFolder: string): Promise<PickLogFolderResult> => {
      if (typeof liveFolder !== "string" || liveFolder.length === 0) {
        return { outcome: "error", error: "No folder provided." };
      }
      return applyLiveFolder(liveFolder);
    },
  );

  // --- App mode (cargo / salvage) -----------------------------------------
  // Read/persist which tracker the app shows. Mode is a pure renderer concern
  // (it swaps the UI + theme); the watcher/store/DB are mode-agnostic, so there
  // is nothing to restart here — just persist so the choice survives a restart.

  ipcMain.handle(IPC.SETTINGS_GET_MODE, (): AppMode => settings.mode);

  ipcMain.handle(IPC.SETTINGS_SET_MODE, (_e, mode: AppMode): AppMode => {
    // saveSettings normalizes an unknown/forged value back to 'cargo' and
    // merges onto disk so the liveFolder key is never dropped.
    settings = saveSettings({ mode });
    return settings.mode;
  });

  // --- Selected ship (Phase A ship picker / hold-capacity bar) -------------
  // Pure renderer concern (drives the capacity bar); the watcher/store/DB are
  // ship-agnostic, so there is nothing to restart — just persist so the chosen
  // ship survives a restart. saveSettings merges onto disk so mode/liveFolder
  // are never dropped, and normalizes an empty/forged slug to null.

  ipcMain.handle(
    IPC.SETTINGS_GET_SHIP,
    (): string | null => settings.selectedShipSlug,
  );

  ipcMain.handle(
    IPC.SETTINGS_SET_SHIP,
    (_e, slug: string | null): string | null => {
      settings = saveSettings({ selectedShipSlug: slug });
      return settings.selectedShipSlug;
    },
  );

  // --- EXPERIMENTAL OCR contract capture (Phase F) ------------------------
  // The feature is opt-in: persist a boolean flag (default false) that gates the
  // capture entry point in the UI. The capture handler grabs the primary display
  // as a PNG data URL via desktopCapturer; the renderer runs tesseract.js + the
  // pure parser/matcher and presents a review-before-apply dialog. NOTHING here
  // ever writes to a mission — application happens via the existing MISSION_UPDATE
  // after the user confirms. The capture handler is fully defensive: any failure
  // returns an { outcome: 'error' } result rather than throwing into the renderer.

  ipcMain.handle(
    IPC.SETTINGS_GET_OCR_ENABLED,
    (): boolean => settings.ocrEnabled,
  );

  ipcMain.handle(
    IPC.SETTINGS_SET_OCR_ENABLED,
    (_e, enabled: boolean): boolean => {
      settings = saveSettings({ ocrEnabled: enabled === true });
      return settings.ocrEnabled;
    },
  );

  ipcMain.handle(
    IPC.OCR_CAPTURE_SCREEN,
    async (): Promise<OcrCaptureResult> => {
      // Honor the gate even if the renderer somehow asks while disabled.
      if (!settings.ocrEnabled) {
        return {
          outcome: "error",
          error: "OCR contract capture is disabled in settings.",
        };
      }
      try {
        // Capture at the primary display's full pixel size so small on-screen
        // text survives for OCR (the default thumbnail size is tiny). The frame
        // is held in renderer memory for the OCR pass only — never written to
        // disk, never sent anywhere.
        const primary = screen.getPrimaryDisplay();
        const { width, height } = primary.size;
        const scale = primary.scaleFactor || 1;
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: {
            width: Math.round(width * scale),
            height: Math.round(height * scale),
          },
        });
        // Prefer the source matching the primary display id; fall back to first.
        const primaryId = String(primary.id);
        const source =
          sources.find((s) => s.display_id === primaryId) ?? sources[0];
        if (!source || source.thumbnail.isEmpty()) {
          return {
            outcome: "error",
            error:
              "Could not capture the screen. On Windows, ensure the app has " +
              "screen-capture permission and the game is not in exclusive " +
              "fullscreen (use borderless/windowed).",
          };
        }
        const size = source.thumbnail.getSize();
        return {
          outcome: "ok",
          dataUrl: source.thumbnail.toDataURL(),
          width: size.width,
          height: size.height,
        };
      } catch (err) {
        console.error("[main] OCR screen capture failed:", err);
        return {
          outcome: "error",
          error:
            "Screen capture failed. " +
            String(err instanceof Error ? err.message : err),
        };
      }
    },
  );

  // Run tesseract.js OCR over the captured frame IN MAIN. The renderer can't load
  // the worker/core/traineddata reliably in the packaged app (sandbox + strict
  // CSP + assets inside app.asar); main loads them from disk with no such limits.
  // Resolves the asset dir from the UNPACKED location (packaged) or the built
  // renderer dir (dev). Fully defensive: any failure returns { outcome: 'error' }
  // instead of throwing into the renderer. The image is consumed in-memory only.
  ipcMain.handle(
    IPC.OCR_RECOGNIZE,
    async (_e, imageDataUrl: string): Promise<OcrRecognizeResult> => {
      if (!settings.ocrEnabled) {
        return {
          outcome: "error",
          error: "OCR contract capture is disabled in settings.",
        };
      }
      try {
        const assetDir = ocrAssetDir({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        });
        const { rawText, confidence } = await recognizeOcr(
          imageDataUrl,
          assetDir,
        );
        return { outcome: "ok", rawText, confidence };
      } catch (err) {
        console.error("[main] OCR recognize failed:", err);
        return {
          outcome: "error",
          error:
            "OCR failed. " + String(err instanceof Error ? err.message : err),
        };
      }
    },
  );

  // --- Overlay window (Phase D) -------------------------------------------
  // Toggle the always-on-top "next stop" overlay open/closed (persists the
  // choice so it restores on the next launch) and report its current state. The
  // overlay is a SECOND window over the same backend — no store/watcher changes.

  ipcMain.handle(IPC.OVERLAY_TOGGLE, (): OverlayState => toggleOverlay());

  ipcMain.handle(IPC.OVERLAY_GET_STATE, (): OverlayState => overlayState());

  // --- Diagnostics / issue report ("Collect Logs") ------------------------
  // Build a timestamped, REDACTED report folder + zip on the Desktop from the
  // user's problem description. Fully defensive: any failure returns an { error }
  // result instead of throwing into the renderer (a reporting tool must never
  // crash the app). The report pairs the Game.log mission-event extract (what the
  // game logged) with the store's captured state (what the app captured).

  ipcMain.handle(
    IPC.DIAGNOSTICS_EXPORT_REPORT,
    (_e, input: { description: string }): ExportReportResult => {
      try {
        const description =
          typeof input?.description === "string" ? input.description : "";
        const userDataDir = app.getPath("userData");
        let desktopDir = userDataDir;
        try {
          desktopDir = app.getPath("desktop");
        } catch {
          desktopDir = userDataDir;
        }
        let windowsUsername: string | null = null;
        try {
          windowsUsername = userInfo().username || null;
        } catch {
          windowsUsername = process.env["USERNAME"] ?? null;
        }

        const out = buildDiagnosticsReport({
          description,
          desktopDir,
          userDataDir,
          appVersion: app.getVersion(),
          mode: settings.mode,
          gameLogPath: resolvedLogPath(),
          windowsUsername,
          missions: safeRead(() => store!.listMissions(), []),
          salvageRuns: salvage ? salvage.listRuns() : [],
        });
        console.log("[main] diagnostics report written:", out.zip);
        return { outcome: "ok", folder: out.folder, zip: out.zip };
      } catch (err) {
        console.error("[main] diagnostics export failed:", err);
        return {
          outcome: "error",
          error:
            "Could not create the report. " +
            String(err instanceof Error ? err.message : err),
        };
      }
    },
  );

  ipcMain.handle(IPC.DIAGNOSTICS_OPEN_PATH, (_e, targetPath: string): void => {
    try {
      if (typeof targetPath === "string" && targetPath.length > 0) {
        shell.showItemInFolder(targetPath);
      }
    } catch (err) {
      console.error("[main] showItemInFolder failed:", err);
    }
  });

  // --- Salvage tracker -----------------------------------------------------
  // Separate domain backed by the salvage store + bundled reference. Every
  // mutation re-broadcasts the full run list (salvage:runs:changed) so any open
  // salvage view stays in sync, mirroring the cargo missions:changed pattern.

  const broadcastSalvageRuns = (): void => {
    if (!salvage) return;
    broadcast(IPC.SALVAGE_RUNS_CHANGED, salvage.listRuns());
  };

  ipcMain.handle(IPC.SALVAGE_LIST_RUNS, (): SalvageRun[] =>
    salvage ? salvage.listRuns() : [],
  );

  ipcMain.handle(IPC.SALVAGE_GET_ACTIVE_RUN, (): SalvageRun | null =>
    salvage ? salvage.getActiveRun() : null,
  );

  ipcMain.handle(
    IPC.SALVAGE_CREATE_RUN,
    (_e, input: SalvageRunInput): SalvageRun => {
      if (!salvage) throw new Error("salvage store not ready");
      const run = salvage.createRun(input);
      broadcastSalvageRuns();
      return run;
    },
  );

  ipcMain.handle(
    IPC.SALVAGE_UPDATE_RUN,
    (_e, runId: string, patch: SalvageRunPatch): SalvageRun => {
      if (!salvage) throw new Error("salvage store not ready");
      const run = salvage.updateRun(runId, patch);
      broadcastSalvageRuns();
      return run;
    },
  );

  ipcMain.handle(
    IPC.SALVAGE_ADD_STRIPPED,
    (_e, runId: string, input: StrippedComponentInput): SalvageRun => {
      if (!salvage) throw new Error("salvage store not ready");
      const run = salvage.addStripped(runId, input);
      broadcastSalvageRuns();
      return run;
    },
  );

  ipcMain.handle(
    IPC.SALVAGE_UPDATE_STRIPPED,
    (
      _e,
      runId: string,
      componentId: string,
      patch: StrippedComponentPatch,
    ): SalvageRun => {
      if (!salvage) throw new Error("salvage store not ready");
      const run = salvage.updateStripped(runId, componentId, patch);
      broadcastSalvageRuns();
      return run;
    },
  );

  ipcMain.handle(
    IPC.SALVAGE_REMOVE_STRIPPED,
    (_e, runId: string, componentId: string): SalvageRun => {
      if (!salvage) throw new Error("salvage store not ready");
      const run = salvage.removeStripped(runId, componentId);
      broadcastSalvageRuns();
      return run;
    },
  );

  ipcMain.handle(IPC.SALVAGE_COMPLETE_RUN, (_e, runId: string): SalvageRun => {
    if (!salvage) throw new Error("salvage store not ready");
    const run = salvage.completeRun(runId);
    broadcastSalvageRuns();
    return run;
  });

  ipcMain.handle(IPC.SALVAGE_DELETE_RUN, (_e, runId: string): void => {
    if (!salvage) return;
    salvage.deleteRun(runId);
    broadcastSalvageRuns();
  });

  ipcMain.handle(IPC.SALVAGE_REFERENCE, (): SalvageReferenceData => {
    if (!salvageRef)
      return {
        ships: [],
        components: [],
        materialPrices: { rmcPerScu: 0, cmatPerScu: 0 },
        haulers: [],
      };
    return salvageRef.getReferenceData();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const userDataDir = app.getPath("userData");

  // Stand up file logging BEFORE anything else so the store open, the watcher's
  // "[main] watching Game.log…" line, the corruption-recovery/quarantine warnings,
  // and the uncaughtException/unhandledRejection handlers are all captured to
  // <userData>/logs/main.log. Fully guarded — an unwritable log dir degrades to
  // console-only and never blocks boot. Console output is preserved.
  installConsoleLogger(join(userDataDir, "logs"));

  // Drop a tiny environment snapshot so the diagnostics collector can report the
  // app/runtime versions even when the app isn't running at collect time.
  writeAppInfo(userDataDir, buildAppInfo(app.getVersion()));

  const dbPath = join(userDataDir, "sc-cargo-tracker.db");

  // Store + UEX share the same sqlite FILE (WAL mode allows it). createDb is
  // `CREATE TABLE IF NOT EXISTS`, so both opening it is idempotent and safe.
  // openMissionStore auto-recovers if the on-disk db is malformed: it quarantines
  // the bad files aside and creates a fresh db. The data is re-derivable from the
  // logs, so the watcher's start()-time backfill below repopulates it.
  store = openMissionStore({
    dbPath,
    onRecover: (quarantinedTo) =>
      console.warn(
        "[main] corrupt database recovered on open; quarantined to:",
        quarantinedTo,
      ),
    // Store-side capture trace -> console -> main.log (see logStoreCapture).
    onCapture: logStoreCapture,
  });
  // Reference data is a bundled local snapshot — no token, no network, no TTL.
  uex = createUexClient();

  // Salvage tracker: its own store over the SAME sqlite file (additive v4
  // tables; WAL allows the shared handle pattern) plus the bundled salvage
  // reference snapshot. Independent of the cargo store/watcher.
  salvage = openSalvageStore({ dbPath });
  salvageRef = createSalvageReference();

  // Load per-user settings (custom LIVE folder) BEFORE resolving the log path.
  // A missing/corrupt file returns safe defaults, so this never blocks boot.
  settings = loadSettings();

  registerIpc();
  createWindow();

  // Restore the overlay if the user left it pinned last session. Created AFTER
  // the main window so it floats above it; its bounds are clamped to a visible
  // display inside createOverlay (a saved off-screen rect can't strand it).
  if (settings.overlayEnabled) {
    createOverlay();
  }

  // The bundled snapshot is always present, so reference data is immediately
  // available. Surface uexActive to the renderer status strip synchronously.
  uexActive = uex.isActive();
  broadcast(IPC.LOG_STATUS_CHANGED, { ...lastLogStatus, uexActive });

  // Resolve the Game.log path from settings: the configured LIVE folder if set
  // AND its Game.log exists, else the default LIVE path (env override wins for
  // dev/testing). startWatcher runs backfill + live tail. Don't await it — the
  // window is already up showing Empty State; missions stream in via
  // missions:changed as backfill + tail produce events.
  void startWatcher(resolvedLogPath()).catch((err) =>
    console.error("[main] watcher.start failed:", err),
  );
}

// ---------------------------------------------------------------------------
// Single-instance lock (PRIMARY corruption fix).
// ----------------------------------------------------------------------------
// The corruption root cause was two concurrent instances writing the same
// WAL-mode db (e.g. the user's app + a dev instance) while backfilling 1000+
// missions. requestSingleInstanceLock() guarantees only ONE process ever opens
// the db: a second launch fails to get the lock, focuses the existing window,
// and quits IMMEDIATELY — before opening the db or creating a window.
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance owns the db. Do NOT open the db or create a window — just
  // exit. The primary instance will receive 'second-instance' and focus itself.
  app.quit();
} else {
  app.on("second-instance", () => {
    // A user (or a dev launch) tried to start a 2nd instance. Surface the
    // existing window instead of opening a 2nd process against the same db.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    void boot();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    destroyOverlay();
    void watcher?.stop();
    uex?.close();
    store?.close();
    salvage?.close();
  });
}

// ---------------------------------------------------------------------------
// Last-resort safety net: a db-corruption error that somehow escapes the
// guarded paths must trigger recover-and-rebuild, NOT a fatal "A JavaScript
// error occurred in the main process" dialog. Anything that is NOT corruption
// is logged cleanly (and NOT swallowed silently — a real bug should still be
// visible in logs/stderr) rather than masked.
// ---------------------------------------------------------------------------

function handleTopLevelError(label: string, err: unknown): void {
  if (isCorruptionError(err) && store) {
    console.warn(
      `[main] ${label}: db corruption caught at top level; recovering`,
    );
    try {
      store.recoverFromCorruption();
      void rebuildAfterRecovery();
    } catch (recoverErr) {
      console.error("[main] top-level recovery failed:", recoverErr);
    }
    return;
  }
  if (err instanceof DatabaseRecoveredError) {
    // Already recovered downstream; just finish the rebuild.
    void rebuildAfterRecovery();
    return;
  }
  // A genuine, non-corruption error. Log it (do not silently swallow). Show a
  // non-fatal dialog only when a window exists; never re-throw (which Electron
  // turns into the fatal main-process crash dialog).
  console.error(`[main] uncaught ${label}:`, err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      dialog.showErrorBox(
        "SC Cargo Tracker — unexpected error",
        `An unexpected error occurred (${label}). The app will keep running.\n\n` +
          String(err instanceof Error ? (err.stack ?? err.message) : err),
      );
    } catch {
      /* dialog best-effort */
    }
  }
}

process.on("uncaughtException", (err) =>
  handleTopLevelError("uncaughtException", err),
);
process.on("unhandledRejection", (reason) =>
  handleTopLevelError("unhandledRejection", reason),
);
