// ============================================================================
// devMockApi — STANDALONE-DEV-ONLY shim behind the real ApiBridge interface.
// ----------------------------------------------------------------------------
// This exists so the renderer can be developed in a plain Vite browser tab
// (no Electron preload) and SEE the UI populated. It is NOT part of the shipped
// app: `installDevMockApi()` is a no-op whenever the real `window.api` (from the
// preload contextBridge) is present, and it only ever runs in dev (import.meta.env.DEV).
//
// REMOVABILITY: deleting this file + the single call in main.tsx removes the
// mock entirely. No component imports it; no mock data is baked into components.
//
// 🚫 Fake-data manifest compliance: this sample is CLEARLY SYNTHETIC (givers
// "DEV Hauling Co" / "DEV Logistics", placeholder commodities/locations prefixed
// "Dev ") and is gated to dev-without-preload, so it never reaches a shipped
// build. The shipped app starts EMPTY → Empty State. None of the prototype's
// real-looking demo seed (the banned givers / payouts / locations) appears here.
// ============================================================================

import type { ApiBridge } from "@shared/ipc";
import type {
  Mission,
  ReferenceData,
  LogStatus,
  ManualMissionInput,
  MissionPatch,
  OcrApplyObjective,
  Leg,
  LogPathInfo,
  PickLogFolderResult,
  ExportReportResult,
  AppMode,
  SalvageRun,
  SalvageRunInput,
  SalvageRunPatch,
  StrippedComponent,
  StrippedComponentInput,
  StrippedComponentPatch,
  SalvageReferenceData,
  MiningReferenceData,
  OcrCaptureRegion,
} from "@shared/types";

let idSeq = 0;
const uid = (p: string): string =>
  `${p}_${(idSeq++).toString(36)}_${Date.now().toString(36)}`;

function mkLeg(over: Partial<Leg>): Leg {
  return {
    id: over.id ?? uid("leg"),
    missionId: over.missionId ?? "",
    kind: over.kind ?? "dropoff",
    commodity: over.commodity ?? "Dev Commodity",
    scuTotal: over.scuTotal ?? 0,
    scuDelivered: over.scuDelivered ?? 0,
    location: over.location ?? null,
    completed: over.completed ?? false,
    position: over.position,
  };
}

// Clearly-synthetic dev seed — exercises aggregation, current-location highlight,
// payout confidence cues, completed/abandoned history, and progress states.
function seedMissions(): Mission[] {
  const m1 = "dev_mission_alpha";
  const m2 = "dev_mission_bravo";
  const m3 = "dev_mission_charlie";
  const m4 = "dev_mission_delta";
  const m5 = "dev_mission_echo";
  const missions: Mission[] = [
    {
      id: m1,
      title: "DEV Sample – Multi-Drop Haul",
      giver: "DEV Hauling Co",
      variant: "SINGLE_TO_MULTI",
      grade: "SUPPLY",
      status: "in_progress",
      payout: 120000,
      payoutConfidence: "confirmed",
      reward: 130000,
      source: "log",
      acceptedAt: Date.now() - 3_600_000,
      completedAt: null,
      notes: "",
      legs: [
        mkLeg({
          missionId: m1,
          kind: "pickup",
          commodity: "Dev Manifested Cargo",
          scuTotal: 360,
          scuDelivered: 360,
          location: "Dev Distribution Hub",
          completed: true,
        }),
        mkLeg({
          missionId: m1,
          kind: "dropoff",
          commodity: "Dev Ice",
          scuTotal: 13,
          scuDelivered: 0,
          location: "Dev Outpost One",
        }),
        mkLeg({
          missionId: m1,
          kind: "dropoff",
          commodity: "Dev Food",
          scuTotal: 188,
          scuDelivered: 0,
          location: "Dev Spaceport",
        }),
        mkLeg({
          missionId: m1,
          kind: "dropoff",
          commodity: "Dev Ice",
          scuTotal: 9,
          scuDelivered: 0,
          location: "Dev Outpost Two",
        }),
        mkLeg({
          missionId: m1,
          kind: "dropoff",
          commodity: "Dev Food",
          scuTotal: 150,
          scuDelivered: 150,
          location: "Dev Outpost One",
          completed: true,
        }),
      ],
    },
    {
      id: m2,
      title: "DEV Sample – Industrial Run",
      giver: "DEV Logistics",
      variant: "A_TO_B",
      grade: "BULK",
      status: "in_progress",
      payout: 90000,
      payoutConfidence: "approximate",
      reward: null,
      source: "log",
      acceptedAt: Date.now() - 1_800_000,
      completedAt: null,
      notes: "",
      legs: [
        mkLeg({
          missionId: m2,
          kind: "pickup",
          commodity: "Dev Manifested Cargo",
          scuTotal: 174,
          scuDelivered: 174,
          location: "Dev Station L1",
          completed: true,
        }),
        mkLeg({
          missionId: m2,
          kind: "dropoff",
          commodity: "Dev Titanium",
          scuTotal: 114,
          scuDelivered: 0,
          location: "Dev Current Stop",
        }),
        mkLeg({
          missionId: m2,
          kind: "dropoff",
          commodity: "Dev Aluminum",
          scuTotal: 60,
          scuDelivered: 0,
          location: "Dev Current Stop",
        }),
      ],
    },
    {
      id: m3,
      title: "DEV Sample – Waste Disposal",
      giver: "DEV Hauling Co",
      variant: "A_TO_B",
      grade: "SMALL",
      status: "accepted",
      payout: null,
      payoutConfidence: "unknown",
      reward: 240000,
      source: "log",
      acceptedAt: Date.now() - 600_000,
      completedAt: null,
      notes: "",
      legs: [
        mkLeg({
          missionId: m3,
          kind: "pickup",
          commodity: "Dev Manifested Cargo",
          scuTotal: 147,
          scuDelivered: 0,
          location: "Dev City",
        }),
        mkLeg({
          missionId: m3,
          kind: "dropoff",
          commodity: "Dev Waste",
          scuTotal: 147,
          scuDelivered: 0,
          location: "Dev Harbor",
        }),
      ],
    },
    // Terminal missions — power the HISTORY view.
    {
      id: m4,
      title: "DEV Sample – Completed Priority",
      giver: "DEV Logistics",
      variant: "A_TO_B",
      grade: "SUPPLY",
      status: "complete",
      payout: 184500,
      payoutConfidence: "confirmed",
      reward: 184500,
      source: "log",
      acceptedAt: Date.now() - 86_400_000,
      completedAt: Date.now() - 80_000_000,
      notes: "",
      legs: [
        mkLeg({
          missionId: m4,
          kind: "pickup",
          commodity: "Dev Manifested Cargo",
          scuTotal: 256,
          scuDelivered: 256,
          location: "Dev City",
          completed: true,
        }),
        mkLeg({
          missionId: m4,
          kind: "dropoff",
          commodity: "Dev Medical",
          scuTotal: 256,
          scuDelivered: 256,
          location: "Dev Station L2",
          completed: true,
        }),
      ],
    },
    {
      id: m5,
      title: "DEV Sample – Abandoned Contract",
      giver: "DEV Hauling Co",
      variant: "SINGLE_TO_MULTI",
      grade: "BULK",
      status: "abandoned",
      payout: null,
      payoutConfidence: "unknown",
      reward: null,
      source: "log",
      acceptedAt: Date.now() - 172_800_000,
      completedAt: Date.now() - 170_000_000,
      notes: "",
      legs: [
        mkLeg({
          missionId: m5,
          kind: "pickup",
          commodity: "Dev Manifested Cargo",
          scuTotal: 200,
          scuDelivered: 0,
          location: "Dev Depot",
        }),
        mkLeg({
          missionId: m5,
          kind: "dropoff",
          commodity: "Dev Scrap",
          scuTotal: 200,
          scuDelivered: 0,
          location: "Dev Reclaimer",
        }),
      ],
    },
  ];
  return missions;
}

const DEV_REFERENCE: ReferenceData = {
  commodities: [
    "Dev Manifested Cargo",
    "Dev Ice",
    "Dev Food",
    "Dev Titanium",
    "Dev Aluminum",
    "Dev Waste",
    "Dev Medical",
    "Dev Scrap",
    "Dev Fuel",
    "Dev Ore",
  ].map((name, i) => ({ name, code: `DEV${i}`, kind: "Dev" })),
  terminals: [
    "Dev Outpost One",
    "Dev Outpost Two",
    "Dev Spaceport",
    "Dev Current Stop",
    "Dev Harbor",
    "Dev Station L2",
    "Dev Distribution Hub",
    "Dev Station L1",
    "Dev City",
    "Dev Depot",
    "Dev Reclaimer",
  ].map((name) => ({
    name,
    displayname: name,
    nickname: name,
    isCargoCenter: true,
    maxContainerSize: 32,
  })),
  ships: [
    { name: "Dev Hull E", scu: 12000 },
    { name: "Dev Hull C", scu: 4608 },
    { name: "Dev Caterpillar", scu: 576 },
    { name: "Dev Freelancer MAX", scu: 120 },
    { name: "Dev Cutlass Black", scu: 46 },
  ].map((s) => ({
    name: s.name,
    nameFull: `Dev ${s.name}`,
    company: "Dev Shipworks",
    slug: s.name.toLowerCase().replace(/\s+/g, "-"),
    scu: s.scu,
    gameVersion: "dev",
  })),
};

const DEV_CURRENT_LOCATION = "Dev Current Stop";

// Clearly-synthetic salvage reference (mirrors the bundled snapshot shape) so
// the salvage UI phase can develop dropdowns/pricing in a plain browser tab.
const DEV_SALVAGE_REFERENCE: SalvageReferenceData = {
  ships: [
    {
      name: "Dev Wreck Alpha",
      costTier: 500,
      claimCost: 500,
      claimCostOrg: 250,
      cmat: 12,
      cargoScu: 0,
      components: {
        powerplant: "1x Dev Plant",
        shield: "2x Dev Shield",
        quantumdrive: "1x Dev Drive",
        cooler: "2x Dev Cooler",
        radar: "1x Dev Radar",
        weapons: ["2x Dev Cannon"],
      },
    },
  ],
  components: [
    {
      type: "weapon",
      model: "Dev Cannon",
      class: "Dev Ballistic",
      size: 4,
      grade: null,
      sellPrice: 3000,
    },
    {
      type: "powerplant",
      model: "Dev Plant",
      class: "Dev Civilian",
      size: 2,
      grade: "C",
      sellPrice: 2400,
    },
  ],
  materialPrices: { rmcPerScu: 7200, cmatPerScu: 12000 },
  haulers: [{ name: "Dev Hauler", gridScu: 64 }],
};

// Tiny mock mining reference so the Mining views (scan lookup / rock table /
// deposits) can be developed in a plain browser tab. Shapes mirror the bundled
// snapshot; values are placeholders, not the real game data.
const DEV_MINING_REFERENCE: MiningReferenceData = {
  rocks: [
    {
      name: "Dev Ice",
      rarity: "Common",
      scanValues: [4300, 8600, 12900, 17200, 21500, 25800],
    },
    {
      name: "Dev Quantainium",
      rarity: "Legendary",
      scanValues: [3170, 6340, 9510, 12680, 15850, 19020],
    },
  ],
  deposits: [
    { name: "Dev Ice", type: "Ship Mineable", foundAt: ["Dev microTech"] },
    {
      name: "Dev Quantainium",
      type: "Ship Mineable (Rare)",
      foundAt: ["Found in All Deposits (Rare)"],
    },
  ],
};

/**
 * Build a mock ApiBridge backed by in-memory state. Mutations behave like the
 * real backend would (returning updated missions, broadcasting changes) so the
 * UI's optimistic+broadcast flow can be developed faithfully.
 */
function createMockApi(): ApiBridge {
  let missions = seedMissions();
  // In-memory mode so the Cargo<->Salvage switcher works in standalone dev.
  let mode: AppMode = "cargo";
  // In-memory selected ship slug for the Phase A ship picker / capacity bar.
  let selectedShipSlug: string | null = null;
  // In-memory overlay open state for standalone-dev of the TopBar pin button.
  let overlayEnabled = false;
  // In-memory experimental-OCR flag (Phase F) for standalone-dev of the toggle.
  let ocrEnabled = false;
  // In-memory Auto OCR Capture flag (Phase 3). The auto path never fires in
  // standalone dev (no OCR_AUTO_REQUEST is ever emitted here), so this just lets
  // the gear checkbox round-trip its value.
  let autoOcrCapture = false;
  // In-memory calibrated OCR capture region (Phase 2). null = uncalibrated; a
  // saved region is clamped to [0,1] proportions like the real normalizer.
  let ocrCaptureRegion: OcrCaptureRegion | null = null;
  // In-memory update-check flag (auto-update) for standalone-dev of the gear
  // toggle. The updater itself never runs in dev (gated on app.isPackaged).
  let updateCheckEnabled = true;
  const overlayListeners = new Set<(s: { enabled: boolean }) => void>();
  // In-memory mode-change listeners so the standalone overlay can swap content
  // live when setMode is called (mirrors the real MODE_CHANGED broadcast).
  const modeListeners = new Set<(m: AppMode) => void>();
  // In-memory salvage runs for standalone-dev of the salvage views.
  let salvageRuns: SalvageRun[] = [];
  const salvageListeners = new Set<(r: SalvageRun[]) => void>();
  const emitSalvage = (): void => {
    const snap = salvageRuns.map((r) => ({
      ...r,
      stripped: r.stripped.map((s) => ({ ...s })),
      wrecks: r.wrecks.map((w) => ({ ...w })),
    }));
    salvageListeners.forEach((cb) => cb(snap));
  };
  const findRun = (id: string): SalvageRun => {
    const r = salvageRuns.find((x) => x.id === id);
    if (!r) throw new Error(`salvage run not found: ${id}`);
    return r;
  };
  const missionListeners = new Set<(m: Mission[]) => void>();
  const emit = (): void => {
    const snapshot = missions.map((m) => ({
      ...m,
      legs: m.legs.map((l) => ({ ...l })),
    }));
    missionListeners.forEach((cb) => cb(snapshot));
  };

  const TERMINAL = new Set(["complete", "abandoned"]);

  return {
    listMissions: async () =>
      missions.map((m) => ({ ...m, legs: m.legs.map((l) => ({ ...l })) })),

    listActiveMissions: async () =>
      missions
        .filter((m) => !TERMINAL.has(m.status))
        .map((m) => ({ ...m, legs: m.legs.map((l) => ({ ...l })) })),

    addMission: async (input: ManualMissionInput) => {
      const id = uid("manual");
      const legs: Leg[] = input.legs.map((lg) =>
        mkLeg({
          missionId: id,
          kind: lg.kind,
          commodity: lg.commodity,
          location: lg.location,
          scuTotal: lg.scuTotal,
        }),
      );
      const mission: Mission = {
        id,
        title: input.title,
        giver: input.giver,
        variant: "MANUAL",
        grade: "UNKNOWN",
        status: input.status,
        payout: null,
        payoutConfidence: "unknown",
        reward: null,
        source: "manual",
        acceptedAt: Date.now(),
        completedAt: null,
        notes: "",
        legs,
      };
      missions = [mission, ...missions];
      emit();
      return mission;
    },

    updateMission: async (missionId: string, patch: MissionPatch) => {
      missions = missions.map((m) => {
        if (m.id !== missionId) return m;
        const next: Mission = { ...m };
        if (patch.payout !== undefined) next.payout = patch.payout;
        if (patch.payoutConfidence !== undefined)
          next.payoutConfidence = patch.payoutConfidence;
        if (patch.reward !== undefined) next.reward = patch.reward;
        if (patch.notes !== undefined) next.notes = patch.notes;
        if (patch.status !== undefined) next.status = patch.status;
        if (patch.legs) {
          next.legs = m.legs.map((l) => {
            const upd = patch.legs?.find((p) => p.legId === l.id);
            if (!upd) return l;
            const nl: Leg = { ...l };
            if (upd.completed !== undefined) {
              nl.completed = upd.completed;
              nl.scuDelivered = upd.completed ? nl.scuTotal : 0;
            }
            if (upd.scuDelivered !== undefined)
              nl.scuDelivered = upd.scuDelivered;
            return nl;
          });
        }
        return next;
      });
      emit();
      return missions.find((m) => m.id === missionId)!;
    },

    // Semantic MERGE of OCR objectives (mirrors the real store's
    // applyOcrObjectives). Dev legs carry no manual_override, so completed is the
    // only protection signal here; the merge fills open legs in place (preserving
    // ids), inserts unmatched objectives, and prunes leftover open legs.
    applyOcr: async (missionId: string, objectives: OcrApplyObjective[]) => {
      missions = missions.map((m) => {
        if (m.id !== missionId) return m;
        const consumed = new Set<string>();
        const next = m.legs.map((l) => ({ ...l }));
        const isCandidate = (l: Leg): boolean => !l.completed;

        for (const o of objectives) {
          const sameKind = next.filter(
            (l) => isCandidate(l) && l.kind === o.kind && !consumed.has(l.id),
          );
          const exact = sameKind.find(
            (l) => l.commodity.toLowerCase() === o.commodity.toLowerCase(),
          );
          const pick = exact ?? sameKind[0];
          if (pick) {
            consumed.add(pick.id);
            if (o.scu !== null) pick.scuTotal = o.scu;
            if (o.location !== null && o.location.length > 0)
              pick.location = o.location;
            if (o.commodity.length > 0) pick.commodity = o.commodity;
          } else {
            next.push(
              mkLeg({
                id: uid(`manual_${o.kind}`),
                missionId,
                kind: o.kind,
                commodity: o.commodity,
                scuTotal: o.scu ?? 0,
                location:
                  o.location && o.location.length > 0 ? o.location : null,
                completed: false,
              }),
            );
          }
        }
        // Prune leftover open legs not matched by any OCR objective. Keep a leg
        // if it is protected (completed), was matched (consumed), or is a freshly
        // inserted leg (not present in the original legs).
        const originalIds = new Set(m.legs.map((l) => l.id));
        const finalLegs = next.filter(
          (l) =>
            !isCandidate(l) || consumed.has(l.id) || !originalIds.has(l.id),
        );
        return { ...m, legs: finalLegs };
      });
      emit();
      return missions.find((m) => m.id === missionId)!;
    },

    abandonMission: async (missionId: string) => {
      missions = missions.map((m) =>
        m.id === missionId
          ? { ...m, status: "abandoned" as const, completedAt: Date.now() }
          : m,
      );
      emit();
    },

    clearActiveMissions: async () => {
      const before = missions.length;
      missions = missions.filter((m) => TERMINAL.has(m.status));
      emit();
      return before - missions.length;
    },

    resetAllData: async () => {
      const before = missions.length;
      missions = [];
      emit();
      return before;
    },

    getReferenceData: async () => DEV_REFERENCE,
    getLogStatus: async (): Promise<LogStatus> => ({
      state: "connected",
      logPath: "C:/[dev-mock]/StarCitizen/LIVE/Game.log",
      uexActive: true,
    }),
    getCurrentLocation: async () => DEV_CURRENT_LOCATION,
    startBackfill: async () => {
      /* overlay is driven by onBackfillProgress in real app; dev no-op */
    },

    getLogPathInfo: async (): Promise<LogPathInfo> => ({
      liveFolder: null,
      gameLogPath: "C:/[dev-mock]/StarCitizen/LIVE/Game.log",
      isDefault: true,
      gameLogExists: true,
    }),
    // Dev mock: no native dialog — simulate a successful re-pick.
    pickLogFolder: async (): Promise<PickLogFolderResult> => ({
      outcome: "ok",
      info: {
        liveFolder: "D:/[dev-mock]/Games/StarCitizen/LIVE",
        gameLogPath: "D:/[dev-mock]/Games/StarCitizen/LIVE/Game.log",
        isDefault: false,
        gameLogExists: true,
      },
    }),
    setLogFolder: async (liveFolder: string): Promise<PickLogFolderResult> => ({
      outcome: "ok",
      info: {
        liveFolder,
        gameLogPath: `${liveFolder}/Game.log`,
        isDefault: false,
        gameLogExists: true,
      },
    }),
    getMode: async (): Promise<AppMode> => mode,
    setMode: async (next: AppMode): Promise<AppMode> => {
      mode =
        next === "salvage" || next === "mining" || next === "cargo"
          ? next
          : "cargo";
      modeListeners.forEach((cb) => cb(mode));
      return mode;
    },
    getSelectedShip: async (): Promise<string | null> => selectedShipSlug,
    setSelectedShip: async (slug: string | null): Promise<string | null> => {
      selectedShipSlug =
        typeof slug === "string" && slug.length > 0 ? slug : null;
      return selectedShipSlug;
    },

    // --- EXPERIMENTAL OCR contract capture (dev stub — Phase F) ---
    // No desktopCapturer in a plain browser tab; the capture call returns an
    // error result so the dev UI degrades gracefully (the dialog shows the
    // "couldn't capture" path). The enabled flag is in-memory only.
    getOcrEnabled: async (): Promise<boolean> => ocrEnabled,
    setOcrEnabled: async (enabled: boolean): Promise<boolean> => {
      ocrEnabled = enabled === true;
      return ocrEnabled;
    },
    getOcrCaptureRegion: async (): Promise<OcrCaptureRegion | null> =>
      ocrCaptureRegion,
    setOcrCaptureRegion: async (
      region: OcrCaptureRegion | null,
    ): Promise<OcrCaptureRegion | null> => {
      // Mirror the real normalizer: clamp to [0,1]; drop a degenerate box to null.
      if (
        region &&
        Number.isFinite(region.x) &&
        Number.isFinite(region.y) &&
        Number.isFinite(region.w) &&
        Number.isFinite(region.h)
      ) {
        const cl = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
        const w = cl(region.w);
        const h = cl(region.h);
        ocrCaptureRegion =
          w > 0 && h > 0 ? { x: cl(region.x), y: cl(region.y), w, h } : null;
      } else {
        ocrCaptureRegion = null;
      }
      return ocrCaptureRegion;
    },
    getAutoOcrCapture: async (): Promise<boolean> => autoOcrCapture,
    setAutoOcrCapture: async (enabled: boolean): Promise<boolean> => {
      autoOcrCapture = enabled === true;
      return autoOcrCapture;
    },
    captureScreenForOcr: async () => ({
      outcome: "error" as const,
      error: "Screen capture is unavailable in standalone dev mode.",
    }),
    recognizeOcr: async (
      _imageDataUrl: string,
      _psm?: "6" | "11",
      _isFullFrame?: boolean,
    ) => ({
      outcome: "error" as const,
      error: "OCR is unavailable in standalone dev mode.",
    }),

    // --- auto-update (dev stub — no updater in a plain browser tab) ---
    // updateCheckEnabled is in-memory; the updater never runs in dev (the real
    // app gates on app.isPackaged), so installUpdate + onUpdateStatus are no-ops.
    getUpdateCheckEnabled: async (): Promise<boolean> => updateCheckEnabled,
    setUpdateCheckEnabled: async (enabled: boolean): Promise<boolean> => {
      updateCheckEnabled = enabled !== false;
      return updateCheckEnabled;
    },
    installUpdate: async (): Promise<void> => {
      /* dev no-op: no electron-updater in a plain browser tab */
    },
    checkForUpdates: async (): Promise<void> => {
      /* dev no-op: no electron-updater in a plain browser tab */
    },

    // --- overlay window (dev stub — no second window in a plain browser tab) ---
    toggleOverlay: async () => {
      overlayEnabled = !overlayEnabled;
      overlayListeners.forEach((cb) => cb({ enabled: overlayEnabled }));
      return { enabled: overlayEnabled };
    },
    getOverlayState: async () => ({ enabled: overlayEnabled }),

    // --- diagnostics / issue report (dev stub — no fs in a browser tab) ---
    exportDiagnostics: async (input: {
      description: string;
    }): Promise<ExportReportResult> => ({
      outcome: "ok",
      folder: "C:/[dev-mock]/Desktop/sc-tracker-report-00000000-000000",
      zip: `C:/[dev-mock]/Desktop/sc-tracker-report-00000000-000000.zip (desc: ${input.description.slice(0, 24)}…)`,
    }),
    openReportPath: async (): Promise<void> => {
      /* dev no-op: no OS shell in a plain browser tab */
    },

    // --- salvage tracker (in-memory dev stubs) ---
    listSalvageRuns: async () =>
      salvageRuns.map((r) => ({
        ...r,
        stripped: r.stripped.map((s) => ({ ...s })),
        wrecks: r.wrecks.map((w) => ({ ...w })),
      })),
    getActiveSalvageRun: async () =>
      salvageRuns.find((r) => r.status === "active") ?? null,
    createSalvageRun: async (input: SalvageRunInput) => {
      const run: SalvageRun = {
        id: uid("run"),
        startedAt: Date.now(),
        completedAt: null,
        status: "active",
        crewSize: Math.max(1, Math.trunc(input.crewSize ?? 1)),
        notes: input.notes ?? "",
        rmcScu: input.rmcScu ?? 0,
        cmatScu: input.cmatScu ?? 0,
        constructionScu: input.constructionScu ?? 0,
        stripped: [],
        wrecks: [],
      };
      salvageRuns = [run, ...salvageRuns];
      emitSalvage();
      return run;
    },
    updateSalvageRun: async (runId: string, patch: SalvageRunPatch) => {
      const run = findRun(runId);
      if (patch.crewSize !== undefined)
        run.crewSize = Math.max(1, Math.trunc(patch.crewSize));
      if (patch.notes !== undefined) run.notes = patch.notes;
      if (patch.rmcScu !== undefined) run.rmcScu = patch.rmcScu;
      if (patch.cmatScu !== undefined) run.cmatScu = patch.cmatScu;
      if (patch.constructionScu !== undefined)
        run.constructionScu = patch.constructionScu;
      if (patch.status !== undefined) {
        run.status = patch.status;
        run.completedAt =
          patch.status === "active" ? null : (run.completedAt ?? Date.now());
      }
      emitSalvage();
      return run;
    },
    addStrippedComponent: async (
      runId: string,
      input: StrippedComponentInput,
    ) => {
      const run = findRun(runId);
      const comp: StrippedComponent = {
        id: uid("strip"),
        runId,
        type: input.type,
        model: input.model,
        qty: Math.max(0, Math.trunc(input.qty)),
        sellPriceEach: Math.max(0, Math.trunc(input.sellPriceEach)),
        sold: input.sold ?? false,
      };
      run.stripped = [...run.stripped, comp];
      emitSalvage();
      return run;
    },
    updateStrippedComponent: async (
      runId: string,
      componentId: string,
      patch: StrippedComponentPatch,
    ) => {
      const run = findRun(runId);
      run.stripped = run.stripped.map((s) =>
        s.id === componentId
          ? {
              ...s,
              ...(patch.type !== undefined ? { type: patch.type } : {}),
              ...(patch.model !== undefined ? { model: patch.model } : {}),
              ...(patch.qty !== undefined
                ? { qty: Math.max(0, Math.trunc(patch.qty)) }
                : {}),
              ...(patch.sellPriceEach !== undefined
                ? {
                    sellPriceEach: Math.max(0, Math.trunc(patch.sellPriceEach)),
                  }
                : {}),
              ...(patch.sold !== undefined ? { sold: patch.sold } : {}),
            }
          : s,
      );
      emitSalvage();
      return run;
    },
    removeStrippedComponent: async (runId: string, componentId: string) => {
      const run = findRun(runId);
      run.stripped = run.stripped.filter((s) => s.id !== componentId);
      emitSalvage();
      return run;
    },
    completeSalvageRun: async (runId: string) => {
      const run = findRun(runId);
      run.status = "sold";
      run.completedAt = run.completedAt ?? Date.now();
      emitSalvage();
      return run;
    },
    deleteSalvageRun: async (runId: string) => {
      salvageRuns = salvageRuns.filter((r) => r.id !== runId);
      emitSalvage();
    },
    getSalvageReference: async (): Promise<SalvageReferenceData> =>
      DEV_SALVAGE_REFERENCE,

    getMiningReference: async (): Promise<MiningReferenceData> =>
      DEV_MINING_REFERENCE,

    onMissionsChanged: (cb) => {
      missionListeners.add(cb);
      return () => missionListeners.delete(cb);
    },
    onLogStatusChanged: () => () => {},
    onBackfillProgress: () => () => {},
    onCurrentLocationChanged: () => () => {},
    onSalvageRunsChanged: (cb) => {
      salvageListeners.add(cb);
      return () => salvageListeners.delete(cb);
    },
    onOverlayStateChanged: (cb) => {
      overlayListeners.add(cb);
      return () => overlayListeners.delete(cb);
    },
    onModeChanged: (cb) => {
      modeListeners.add(cb);
      return () => modeListeners.delete(cb);
    },
    // No updater in standalone dev — never emits, so the banner never shows.
    onUpdateStatus: () => () => {},
    // No log watcher in standalone dev — the auto-capture signal never fires, so
    // this subscription is inert (unsubscribe is a no-op).
    onOcrAutoRequest: () => () => {},
  };
}

/**
 * Install the dev mock onto `window.api` IFF:
 *  - running in Vite dev (import.meta.env.DEV), AND
 *  - the real preload bridge is absent (no window.api).
 * In a packaged/Electron build the preload always defines window.api, so this
 * is a hard no-op and the shipped app uses the real backend exclusively.
 */
export function installDevMockApi(): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  if ((window as unknown as { api?: ApiBridge }).api) return;
  (window as unknown as { api: ApiBridge }).api = createMockApi();
  // eslint-disable-next-line no-console
  console.warn(
    "[SC Tracker] DEV MOCK window.api installed (no preload bridge found). " +
      "This is standalone-dev only and never ships.",
  );
}
