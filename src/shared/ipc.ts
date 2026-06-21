// ============================================================================
// SC Cargo Tracker — Typed IPC Contract
// ----------------------------------------------------------------------------
// THIS FILE IS A CONTRACT. Channel names + payload/return shapes for every
// renderer<->main exchange. The preload (src/preload) exposes these as a typed
// `window.api`; main handlers (electron/main.ts) implement them.
// Parallel phases import from here — do not redefine channels elsewhere.
// ============================================================================

import type {
  Mission,
  MissionPatch,
  ManualMissionInput,
  ReferenceData,
  LogStatus,
  BackfillProgress,
  LogPathInfo,
  PickLogFolderResult,
} from "./types";

// ---------------------------------------------------------------------------
// Channel name constants (single source of truth — no string literals elsewhere)
// ---------------------------------------------------------------------------

export const IPC = {
  // request/response (renderer.invoke -> main.handle)
  MISSION_LIST: "mission:list",
  MISSION_ACTIVE: "mission:active",
  MISSION_ADD: "mission:add",
  MISSION_UPDATE: "mission:update",
  MISSION_ABANDON: "mission:abandon",
  MISSION_CLEAR_ACTIVE: "mission:clearActive",
  DATA_RESET: "data:reset",
  REF_GET: "ref:get",
  LOG_STATUS: "log:status",
  CURRENT_LOCATION_GET: "currentLocation:get",
  BACKFILL_START: "backfill:start",
  SETTINGS_GET_LOG_PATH: "settings:getLogPath",
  SETTINGS_PICK_LOG_FOLDER: "settings:pickLogFolder",
  SETTINGS_SET_LOG_PATH: "settings:setLogPath",

  // push events (main.send -> renderer.on)
  MISSIONS_CHANGED: "missions:changed",
  LOG_STATUS_CHANGED: "log:status:changed",
  BACKFILL_PROGRESS: "backfill:progress",
  CURRENT_LOCATION_CHANGED: "currentLocation:changed",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

// ---------------------------------------------------------------------------
// Request/response contracts — one entry per invoke channel.
// `args` is the tuple passed by the renderer; `result` is what main returns.
// ---------------------------------------------------------------------------

export interface IpcRequestMap {
  [IPC.MISSION_LIST]: { args: []; result: Mission[] };
  [IPC.MISSION_ACTIVE]: { args: []; result: Mission[] };
  [IPC.MISSION_ADD]: { args: [input: ManualMissionInput]; result: Mission };
  [IPC.MISSION_UPDATE]: {
    args: [missionId: string, patch: MissionPatch];
    result: Mission;
  };
  [IPC.MISSION_ABANDON]: { args: [missionId: string]; result: void };
  /** Clear the active Mission List (delete live, non-terminal missions). Returns count removed. */
  [IPC.MISSION_CLEAR_ACTIVE]: { args: []; result: number };
  /** Wipe all mission data + re-run backfill under corrected rules. Returns count removed. */
  [IPC.DATA_RESET]: { args: []; result: number };
  [IPC.REF_GET]: { args: []; result: ReferenceData };
  [IPC.LOG_STATUS]: { args: []; result: LogStatus };
  [IPC.CURRENT_LOCATION_GET]: { args: []; result: string | null };
  [IPC.BACKFILL_START]: { args: []; result: void };
  /** Current Game.log path resolution for the settings UI. */
  [IPC.SETTINGS_GET_LOG_PATH]: { args: []; result: LogPathInfo };
  /** Open the native folder picker; validate, save, and restart the watcher. */
  [IPC.SETTINGS_PICK_LOG_FOLDER]: { args: []; result: PickLogFolderResult };
  /** Set a typed LIVE folder path (nice-to-have; same validate+restart flow). */
  [IPC.SETTINGS_SET_LOG_PATH]: {
    args: [liveFolder: string];
    result: PickLogFolderResult;
  };
}

// ---------------------------------------------------------------------------
// Push event contracts — one entry per send channel. `payload` is delivered to
// the renderer listener.
// ---------------------------------------------------------------------------

export interface IpcEventMap {
  [IPC.MISSIONS_CHANGED]: { payload: Mission[] };
  [IPC.LOG_STATUS_CHANGED]: { payload: LogStatus };
  [IPC.BACKFILL_PROGRESS]: { payload: BackfillProgress };
  [IPC.CURRENT_LOCATION_CHANGED]: { payload: string | null };
}

// ---------------------------------------------------------------------------
// The typed surface exposed on `window.api` by the preload contextBridge.
// Renderer code calls these; it never touches ipcRenderer directly.
// ---------------------------------------------------------------------------

export interface ApiBridge {
  // invoke-style (return a Promise of the channel's result)
  listMissions(): Promise<Mission[]>;
  /** Active Mission-List missions: current-session (live) + non-terminal only. */
  listActiveMissions(): Promise<Mission[]>;
  addMission(input: ManualMissionInput): Promise<Mission>;
  updateMission(missionId: string, patch: MissionPatch): Promise<Mission>;
  abandonMission(missionId: string): Promise<void>;
  /** Clear the active Mission List. Resolves to the number of missions removed. */
  clearActiveMissions(): Promise<number>;
  /** Wipe all data and re-run backfill. Resolves to the number of missions removed. */
  resetAllData(): Promise<number>;
  getReferenceData(): Promise<ReferenceData>;
  getLogStatus(): Promise<LogStatus>;
  getCurrentLocation(): Promise<string | null>;
  startBackfill(): Promise<void>;
  /** Current Game.log path resolution (for the settings panel display). */
  getLogPathInfo(): Promise<LogPathInfo>;
  /** Open the native folder picker; on a valid pick, save + retarget the watcher. */
  pickLogFolder(): Promise<PickLogFolderResult>;
  /** Set a typed LIVE folder; same validate + save + retarget flow as the picker. */
  setLogFolder(liveFolder: string): Promise<PickLogFolderResult>;

  // subscriptions — each returns an unsubscribe function
  onMissionsChanged(cb: (missions: Mission[]) => void): () => void;
  onLogStatusChanged(cb: (status: LogStatus) => void): () => void;
  onBackfillProgress(cb: (progress: BackfillProgress) => void): () => void;
  onCurrentLocationChanged(cb: (location: string | null) => void): () => void;
}
