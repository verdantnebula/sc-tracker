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
  Leg,
  LogPathInfo,
  PickLogFolderResult,
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
};

const DEV_CURRENT_LOCATION = "Dev Current Stop";

/**
 * Build a mock ApiBridge backed by in-memory state. Mutations behave like the
 * real backend would (returning updated missions, broadcasting changes) so the
 * UI's optimistic+broadcast flow can be developed faithfully.
 */
function createMockApi(): ApiBridge {
  let missions = seedMissions();
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

    onMissionsChanged: (cb) => {
      missionListeners.add(cb);
      return () => missionListeners.delete(cb);
    },
    onLogStatusChanged: () => () => {},
    onBackfillProgress: () => () => {},
    onCurrentLocationChanged: () => () => {},
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
    "[SC Cargo Tracker] DEV MOCK window.api installed (no preload bridge found). " +
      "This is standalone-dev only and never ships.",
  );
}
