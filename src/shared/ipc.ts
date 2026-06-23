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
  ExportReportResult,
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
  MiningReferenceData,
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
  SETTINGS_GET_MODE: "settings:getMode",
  SETTINGS_SET_MODE: "settings:setMode",
  SETTINGS_GET_SHIP: "settings:getShip",
  SETTINGS_SET_SHIP: "settings:setShip",
  SETTINGS_GET_OCR_ENABLED: "settings:getOcrEnabled",
  SETTINGS_SET_OCR_ENABLED: "settings:setOcrEnabled",

  // EXPERIMENTAL OCR contract capture (Phase F) — capture the primary display
  // as a PNG data URL in main; main also runs tesseract.js (assets load from
  // disk there, unconstrained by the renderer's CSP/sandbox) and returns text.
  OCR_CAPTURE_SCREEN: "ocr:captureScreen",
  OCR_RECOGNIZE: "ocr:recognize",

  // always-on-top "next stop" overlay window (Phase D)
  OVERLAY_TOGGLE: "overlay:toggle",
  OVERLAY_GET_STATE: "overlay:getState",

  // diagnostics / issue report ("Collect Logs")
  DIAGNOSTICS_EXPORT_REPORT: "diagnostics:exportReport",
  DIAGNOSTICS_OPEN_PATH: "diagnostics:openPath",

  // salvage tracker (additive — separate domain, separate tables)
  SALVAGE_LIST_RUNS: "salvage:listRuns",
  SALVAGE_GET_ACTIVE_RUN: "salvage:getActiveRun",
  SALVAGE_CREATE_RUN: "salvage:createRun",
  SALVAGE_UPDATE_RUN: "salvage:updateRun",
  SALVAGE_ADD_STRIPPED: "salvage:addStripped",
  SALVAGE_UPDATE_STRIPPED: "salvage:updateStripped",
  SALVAGE_REMOVE_STRIPPED: "salvage:removeStripped",
  SALVAGE_COMPLETE_RUN: "salvage:completeRun",
  SALVAGE_DELETE_RUN: "salvage:deleteRun",
  SALVAGE_REFERENCE: "salvage:reference",

  // mining reference (additive — bundled, read-only game reference data)
  MINING_REFERENCE: "mining:reference",

  // push events (main.send -> renderer.on)
  MISSIONS_CHANGED: "missions:changed",
  LOG_STATUS_CHANGED: "log:status:changed",
  BACKFILL_PROGRESS: "backfill:progress",
  CURRENT_LOCATION_CHANGED: "currentLocation:changed",
  SALVAGE_RUNS_CHANGED: "salvage:runs:changed",
  OVERLAY_STATE_CHANGED: "overlay:state:changed",
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
  /** Current app mode ('cargo' | 'salvage') from persisted settings. */
  [IPC.SETTINGS_GET_MODE]: { args: []; result: AppMode };
  /** Persist a new app mode; returns the saved mode (defaults defensively). */
  [IPC.SETTINGS_SET_MODE]: { args: [mode: AppMode]; result: AppMode };
  /** Current selected ship slug (Phase A), or null when unset. */
  [IPC.SETTINGS_GET_SHIP]: { args: []; result: string | null };
  /** Persist the selected ship slug; returns the saved slug (null when cleared). */
  [IPC.SETTINGS_SET_SHIP]: {
    args: [slug: string | null];
    result: string | null;
  };
  /** EXPERIMENTAL OCR fallback enabled? (Phase F; default false). */
  [IPC.SETTINGS_GET_OCR_ENABLED]: { args: []; result: boolean };
  /** Persist the OCR-enabled flag; returns the saved value. */
  [IPC.SETTINGS_SET_OCR_ENABLED]: {
    args: [enabled: boolean];
    result: boolean;
  };
  /** Capture the primary display as a PNG data URL for OCR (Phase F). */
  [IPC.OCR_CAPTURE_SCREEN]: { args: []; result: OcrCaptureResult };
  /**
   * Run tesseract.js OCR (in main) over a PREPROCESSED crop PNG data URL
   * (Phase F). Optional `psm` selects the page-segmentation mode ("6" uniform
   * block, default; "11" sparse) so the renderer can retry a loose layout.
   */
  [IPC.OCR_RECOGNIZE]: {
    args: [imageDataUrl: string, psm?: "6" | "11"];
    result: OcrRecognizeResult;
  };

  // --- overlay window (Phase D) ---
  /** Toggle the always-on-top overlay open/closed; returns the resulting state. */
  [IPC.OVERLAY_TOGGLE]: { args: []; result: OverlayState };
  /** Read whether the overlay is currently open (for the TopBar pin button). */
  [IPC.OVERLAY_GET_STATE]: { args: []; result: OverlayState };

  // --- diagnostics / issue report ---
  /** Build a redacted issue-report folder + zip on the Desktop from a description. */
  [IPC.DIAGNOSTICS_EXPORT_REPORT]: {
    args: [input: { description: string }];
    result: ExportReportResult;
  };
  /** Reveal a path in the OS file manager (shell.showItemInFolder). */
  [IPC.DIAGNOSTICS_OPEN_PATH]: { args: [targetPath: string]; result: void };

  // --- salvage tracker ---
  /** All salvage runs, newest first. */
  [IPC.SALVAGE_LIST_RUNS]: { args: []; result: SalvageRun[] };
  /** The single active run, or null when none is open. */
  [IPC.SALVAGE_GET_ACTIVE_RUN]: { args: []; result: SalvageRun | null };
  /** Create (and open) a new run. Returns the created run. */
  [IPC.SALVAGE_CREATE_RUN]: {
    args: [input: SalvageRunInput];
    result: SalvageRun;
  };
  /** Patch a run's materials / crewSize / notes / status. Returns the updated run. */
  [IPC.SALVAGE_UPDATE_RUN]: {
    args: [runId: string, patch: SalvageRunPatch];
    result: SalvageRun;
  };
  /** Add a stripped component to a run. Returns the updated run. */
  [IPC.SALVAGE_ADD_STRIPPED]: {
    args: [runId: string, input: StrippedComponentInput];
    result: SalvageRun;
  };
  /** Patch a stripped component (qty / price / sold). Returns the updated run. */
  [IPC.SALVAGE_UPDATE_STRIPPED]: {
    args: [runId: string, componentId: string, patch: StrippedComponentPatch];
    result: SalvageRun;
  };
  /** Remove a stripped component from a run. Returns the updated run. */
  [IPC.SALVAGE_REMOVE_STRIPPED]: {
    args: [runId: string, componentId: string];
    result: SalvageRun;
  };
  /** Mark a run sold (terminal). Returns the updated run. */
  [IPC.SALVAGE_COMPLETE_RUN]: { args: [runId: string]; result: SalvageRun };
  /** Hard-delete a run (and its components/wrecks). */
  [IPC.SALVAGE_DELETE_RUN]: { args: [runId: string]; result: void };
  /** The bundled salvage reference snapshot (ships/components/prices/haulers). */
  [IPC.SALVAGE_REFERENCE]: { args: []; result: SalvageReferenceData };

  // --- mining reference ---
  /** The bundled mining reference snapshot (rocks + deposits). */
  [IPC.MINING_REFERENCE]: { args: []; result: MiningReferenceData };
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
  [IPC.SALVAGE_RUNS_CHANGED]: { payload: SalvageRun[] };
  [IPC.OVERLAY_STATE_CHANGED]: { payload: OverlayState };
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
  /** Read the persisted app mode ('cargo' | 'salvage'). */
  getMode(): Promise<AppMode>;
  /** Persist the app mode; resolves to the saved mode. */
  setMode(mode: AppMode): Promise<AppMode>;
  /** Read the persisted selected ship slug (null when unset). */
  getSelectedShip(): Promise<string | null>;
  /** Persist the selected ship slug (null clears it); resolves to the saved slug. */
  setSelectedShip(slug: string | null): Promise<string | null>;

  // --- EXPERIMENTAL OCR contract capture (Phase F) ---
  /** Read whether the experimental OCR fallback is enabled (default false). */
  getOcrEnabled(): Promise<boolean>;
  /** Persist the OCR-enabled flag; resolves to the saved value. */
  setOcrEnabled(enabled: boolean): Promise<boolean>;
  /** Capture the primary display as a PNG data URL for the OCR pipeline. */
  captureScreenForOcr(): Promise<OcrCaptureResult>;
  /**
   * Run OCR (in main) over a PREPROCESSED crop PNG data URL; resolves text +
   * confidence. Optional `psm` selects the page-segmentation mode (default "6").
   */
  recognizeOcr(
    imageDataUrl: string,
    psm?: "6" | "11",
  ): Promise<OcrRecognizeResult>;

  // --- overlay window (Phase D) ---
  /** Toggle the always-on-top overlay open/closed; resolves to the new state. */
  toggleOverlay(): Promise<OverlayState>;
  /** Read whether the overlay is currently open. */
  getOverlayState(): Promise<OverlayState>;

  // --- diagnostics / issue report ("Collect Logs") ---
  /** Build a redacted issue-report folder + zip on the Desktop. */
  exportDiagnostics(input: {
    description: string;
  }): Promise<ExportReportResult>;
  /** Reveal a saved report path in the OS file manager. */
  openReportPath(targetPath: string): Promise<void>;

  // --- salvage tracker ---
  /** All salvage runs, newest first. */
  listSalvageRuns(): Promise<SalvageRun[]>;
  /** The single active run, or null when none is open. */
  getActiveSalvageRun(): Promise<SalvageRun | null>;
  /** Create + open a new run. */
  createSalvageRun(input: SalvageRunInput): Promise<SalvageRun>;
  /** Patch a run's materials / crewSize / notes / status. */
  updateSalvageRun(runId: string, patch: SalvageRunPatch): Promise<SalvageRun>;
  /** Add a stripped component to a run. */
  addStrippedComponent(
    runId: string,
    input: StrippedComponentInput,
  ): Promise<SalvageRun>;
  /** Patch a stripped component (qty / price / sold). */
  updateStrippedComponent(
    runId: string,
    componentId: string,
    patch: StrippedComponentPatch,
  ): Promise<SalvageRun>;
  /** Remove a stripped component from a run. */
  removeStrippedComponent(
    runId: string,
    componentId: string,
  ): Promise<SalvageRun>;
  /** Mark a run sold (terminal). */
  completeSalvageRun(runId: string): Promise<SalvageRun>;
  /** Hard-delete a run. */
  deleteSalvageRun(runId: string): Promise<void>;
  /** The bundled salvage reference snapshot. */
  getSalvageReference(): Promise<SalvageReferenceData>;

  // --- mining reference ---
  /** The bundled mining reference snapshot (rocks + deposits). */
  getMiningReference(): Promise<MiningReferenceData>;

  // subscriptions — each returns an unsubscribe function
  onMissionsChanged(cb: (missions: Mission[]) => void): () => void;
  onLogStatusChanged(cb: (status: LogStatus) => void): () => void;
  onBackfillProgress(cb: (progress: BackfillProgress) => void): () => void;
  onCurrentLocationChanged(cb: (location: string | null) => void): () => void;
  /** Salvage runs changed (mutation broadcast). */
  onSalvageRunsChanged(cb: (runs: SalvageRun[]) => void): () => void;
  /** Overlay open/closed state changed (e.g. overlay closed via its own control). */
  onOverlayStateChanged(cb: (state: OverlayState) => void): () => void;
}
