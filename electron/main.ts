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

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "node:path";
import { IPC } from "@shared/ipc";
import type {
  Mission,
  ReferenceData,
  LogStatus,
  ManualMissionInput,
  MissionPatch,
  LogPathInfo,
  PickLogFolderResult,
} from "@shared/types";
import type { DomainEvent } from "@shared/events";
import {
  openMissionStore,
  DatabaseRecoveredError,
  type MissionStore,
} from "./missionStore";
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
  type AppSettings,
} from "./settings";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Process-wide singletons, created on app-ready (need app.getPath('userData')).
// ---------------------------------------------------------------------------

let store: MissionStore | null = null;
let uex: UexClient | null = null;
let watcher: LogWatcher | null = null;
let mainWindow: BrowserWindow | null = null;

// Per-user settings (custom LIVE folder, etc.), loaded on boot. Held in memory
// so the IPC handlers can report/resolve the current Game.log path without a disk
// read each call; saveSettings() still merges onto disk as the source of truth.
let settings: AppSettings = { liveFolder: null };

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
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
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
    if (!uex) return { commodities: [], terminals: [] };
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
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  const dbPath = join(app.getPath("userData"), "sc-cargo-tracker.db");

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
  });
  // Reference data is a bundled local snapshot — no token, no network, no TTL.
  uex = createUexClient();

  // Load per-user settings (custom LIVE folder) BEFORE resolving the log path.
  // A missing/corrupt file returns safe defaults, so this never blocks boot.
  settings = loadSettings();

  registerIpc();
  createWindow();

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
    void watcher?.stop();
    uex?.close();
    store?.close();
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
