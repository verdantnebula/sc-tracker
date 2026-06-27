// ============================================================================
// preload — typed contextBridge  (SPEC §3, §6 /preload.ts)
// ----------------------------------------------------------------------------
// Exposes the ApiBridge contract (src/shared/ipc.ts) on window.api. The renderer
// NEVER touches ipcRenderer directly — only this typed surface. contextIsolation
// is on, so this is the only channel between worlds.
// ============================================================================

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@shared/ipc";
import type { ApiBridge } from "@shared/ipc";
import type {
  Mission,
  ManualMissionInput,
  MissionPatch,
  OcrApplyObjective,
  ReferenceData,
  LogStatus,
  BackfillProgress,
  LogPathInfo,
  PickLogFolderResult,
  ExportReportResult,
  OcrCaptureResult,
  OcrRecognizeResult,
  OcrCaptureRegion,
  OcrAutoRequest,
  AppMode,
  OverlayState,
  SalvageRun,
  SalvageRunInput,
  SalvageRunPatch,
  StrippedComponentInput,
  StrippedComponentPatch,
  SalvageReferenceData,
  MiningReferenceData,
  UpdateStatus,
} from "@shared/types";

/** Subscribe to a push channel; returns an unsubscribe fn. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void =>
    cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: ApiBridge = {
  listMissions: () =>
    ipcRenderer.invoke(IPC.MISSION_LIST) as Promise<Mission[]>,
  listActiveMissions: () =>
    ipcRenderer.invoke(IPC.MISSION_ACTIVE) as Promise<Mission[]>,
  addMission: (input: ManualMissionInput) =>
    ipcRenderer.invoke(IPC.MISSION_ADD, input) as Promise<Mission>,
  updateMission: (missionId: string, patch: MissionPatch) =>
    ipcRenderer.invoke(
      IPC.MISSION_UPDATE,
      missionId,
      patch,
    ) as Promise<Mission>,
  applyOcr: (missionId: string, objectives: OcrApplyObjective[]) =>
    ipcRenderer.invoke(
      IPC.MISSION_APPLY_OCR,
      missionId,
      objectives,
    ) as Promise<Mission>,
  abandonMission: (missionId: string) =>
    ipcRenderer.invoke(IPC.MISSION_ABANDON, missionId) as Promise<void>,
  clearActiveMissions: () =>
    ipcRenderer.invoke(IPC.MISSION_CLEAR_ACTIVE) as Promise<number>,
  resetAllData: () => ipcRenderer.invoke(IPC.DATA_RESET) as Promise<number>,
  getReferenceData: () =>
    ipcRenderer.invoke(IPC.REF_GET) as Promise<ReferenceData>,
  getLogStatus: () => ipcRenderer.invoke(IPC.LOG_STATUS) as Promise<LogStatus>,
  getCurrentLocation: () =>
    ipcRenderer.invoke(IPC.CURRENT_LOCATION_GET) as Promise<string | null>,
  startBackfill: () => ipcRenderer.invoke(IPC.BACKFILL_START) as Promise<void>,
  getLogPathInfo: () =>
    ipcRenderer.invoke(IPC.SETTINGS_GET_LOG_PATH) as Promise<LogPathInfo>,
  pickLogFolder: () =>
    ipcRenderer.invoke(
      IPC.SETTINGS_PICK_LOG_FOLDER,
    ) as Promise<PickLogFolderResult>,
  setLogFolder: (liveFolder: string) =>
    ipcRenderer.invoke(
      IPC.SETTINGS_SET_LOG_PATH,
      liveFolder,
    ) as Promise<PickLogFolderResult>,
  getMode: () => ipcRenderer.invoke(IPC.SETTINGS_GET_MODE) as Promise<AppMode>,
  setMode: (mode: AppMode) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET_MODE, mode) as Promise<AppMode>,
  getSelectedShip: () =>
    ipcRenderer.invoke(IPC.SETTINGS_GET_SHIP) as Promise<string | null>,
  setSelectedShip: (slug: string | null) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET_SHIP, slug) as Promise<string | null>,

  // --- EXPERIMENTAL OCR contract capture (Phase F) ---
  getOcrEnabled: () =>
    ipcRenderer.invoke(IPC.SETTINGS_GET_OCR_ENABLED) as Promise<boolean>,
  setOcrEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(
      IPC.SETTINGS_SET_OCR_ENABLED,
      enabled,
    ) as Promise<boolean>,
  getOcrCaptureRegion: () =>
    ipcRenderer.invoke(
      IPC.SETTINGS_GET_OCR_REGION,
    ) as Promise<OcrCaptureRegion | null>,
  setOcrCaptureRegion: (region: OcrCaptureRegion | null) =>
    ipcRenderer.invoke(
      IPC.SETTINGS_SET_OCR_REGION,
      region,
    ) as Promise<OcrCaptureRegion | null>,
  getAutoOcrCapture: () =>
    ipcRenderer.invoke(IPC.SETTINGS_GET_AUTO_OCR) as Promise<boolean>,
  setAutoOcrCapture: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.SETTINGS_SET_AUTO_OCR, enabled) as Promise<boolean>,
  captureScreenForOcr: () =>
    ipcRenderer.invoke(IPC.OCR_CAPTURE_SCREEN) as Promise<OcrCaptureResult>,
  recognizeOcr: (imageDataUrl: string, psm?: "6" | "11") =>
    ipcRenderer.invoke(
      IPC.OCR_RECOGNIZE,
      imageDataUrl,
      psm,
    ) as Promise<OcrRecognizeResult>,

  // --- auto-update (electron-updater) ---
  getUpdateCheckEnabled: () =>
    ipcRenderer.invoke(
      IPC.SETTINGS_GET_UPDATE_CHECK_ENABLED,
    ) as Promise<boolean>,
  setUpdateCheckEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(
      IPC.SETTINGS_SET_UPDATE_CHECK_ENABLED,
      enabled,
    ) as Promise<boolean>,
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL) as Promise<void>,
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC.UPDATE_CHECK_NOW) as Promise<void>,

  // --- overlay window (Phase D) ---
  toggleOverlay: () =>
    ipcRenderer.invoke(IPC.OVERLAY_TOGGLE) as Promise<OverlayState>,
  getOverlayState: () =>
    ipcRenderer.invoke(IPC.OVERLAY_GET_STATE) as Promise<OverlayState>,

  // --- diagnostics / issue report ("Collect Logs") ---
  exportDiagnostics: (input: { description: string }) =>
    ipcRenderer.invoke(
      IPC.DIAGNOSTICS_EXPORT_REPORT,
      input,
    ) as Promise<ExportReportResult>,
  openReportPath: (targetPath: string) =>
    ipcRenderer.invoke(IPC.DIAGNOSTICS_OPEN_PATH, targetPath) as Promise<void>,

  // --- salvage tracker ---
  listSalvageRuns: () =>
    ipcRenderer.invoke(IPC.SALVAGE_LIST_RUNS) as Promise<SalvageRun[]>,
  getActiveSalvageRun: () =>
    ipcRenderer.invoke(
      IPC.SALVAGE_GET_ACTIVE_RUN,
    ) as Promise<SalvageRun | null>,
  createSalvageRun: (input: SalvageRunInput) =>
    ipcRenderer.invoke(IPC.SALVAGE_CREATE_RUN, input) as Promise<SalvageRun>,
  updateSalvageRun: (runId: string, patch: SalvageRunPatch) =>
    ipcRenderer.invoke(
      IPC.SALVAGE_UPDATE_RUN,
      runId,
      patch,
    ) as Promise<SalvageRun>,
  addStrippedComponent: (runId: string, input: StrippedComponentInput) =>
    ipcRenderer.invoke(
      IPC.SALVAGE_ADD_STRIPPED,
      runId,
      input,
    ) as Promise<SalvageRun>,
  updateStrippedComponent: (
    runId: string,
    componentId: string,
    patch: StrippedComponentPatch,
  ) =>
    ipcRenderer.invoke(
      IPC.SALVAGE_UPDATE_STRIPPED,
      runId,
      componentId,
      patch,
    ) as Promise<SalvageRun>,
  removeStrippedComponent: (runId: string, componentId: string) =>
    ipcRenderer.invoke(
      IPC.SALVAGE_REMOVE_STRIPPED,
      runId,
      componentId,
    ) as Promise<SalvageRun>,
  completeSalvageRun: (runId: string) =>
    ipcRenderer.invoke(IPC.SALVAGE_COMPLETE_RUN, runId) as Promise<SalvageRun>,
  deleteSalvageRun: (runId: string) =>
    ipcRenderer.invoke(IPC.SALVAGE_DELETE_RUN, runId) as Promise<void>,
  getSalvageReference: () =>
    ipcRenderer.invoke(IPC.SALVAGE_REFERENCE) as Promise<SalvageReferenceData>,

  // --- mining reference ---
  getMiningReference: () =>
    ipcRenderer.invoke(IPC.MINING_REFERENCE) as Promise<MiningReferenceData>,

  onMissionsChanged: (cb) => subscribe<Mission[]>(IPC.MISSIONS_CHANGED, cb),
  onLogStatusChanged: (cb) => subscribe<LogStatus>(IPC.LOG_STATUS_CHANGED, cb),
  onBackfillProgress: (cb) =>
    subscribe<BackfillProgress>(IPC.BACKFILL_PROGRESS, cb),
  onCurrentLocationChanged: (cb) =>
    subscribe<string | null>(IPC.CURRENT_LOCATION_CHANGED, cb),
  onSalvageRunsChanged: (cb) =>
    subscribe<SalvageRun[]>(IPC.SALVAGE_RUNS_CHANGED, cb),
  onOverlayStateChanged: (cb) =>
    subscribe<OverlayState>(IPC.OVERLAY_STATE_CHANGED, cb),
  onModeChanged: (cb) => subscribe<AppMode>(IPC.MODE_CHANGED, cb),
  onUpdateStatus: (cb) => subscribe<UpdateStatus>(IPC.UPDATE_STATUS, cb),
  onOcrAutoRequest: (cb) => subscribe<OcrAutoRequest>(IPC.OCR_AUTO_REQUEST, cb),
};

contextBridge.exposeInMainWorld("api", api);
