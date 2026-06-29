// ============================================================================
// App.tsx — the renderer shell. Owns all UI state and wires every interaction
// to the typed `window.api` bridge (@shared/ipc). Missions/reference/log status/
// current location/backfill all flow through window.api. The app starts EMPTY:
// with no missions it shows the Empty State (SPEC §10 fake-data manifest).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type {
  Mission,
  LegKind,
  LogStatus,
  ReferenceData,
  BackfillProgress,
  ManualMissionInput,
  LogPathInfo,
  AppMode,
} from "@shared/types";

import type { UpdateStatus } from "@shared/types";

import { TopBar } from "./components/TopBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { ShipPicker } from "./components/ShipPicker";
import { CapacityBar } from "./components/CapacityBar";
import { SalvageShell } from "./components/SalvageShell";
import { MiningShell } from "./components/MiningShell";
import { applyTheme } from "./lib/theme";
import { LogMissingBanner } from "./components/LogMissingBanner";
import { TabBar, type TabKey } from "./components/TabBar";
import { DropoffView } from "./components/DropoffView";
import { RouteView } from "./components/RouteView";
import { MissionListView } from "./components/MissionListView";
import { HistoryView } from "./components/HistoryView";
import { MissionDetailPanel } from "./components/MissionDetailPanel";
import { ManualEntryForm } from "./components/ManualEntryForm";
import { BackfillOverlay } from "./components/BackfillOverlay";
import { EmptyState } from "./components/EmptyState";
import { CollectLogsDialog } from "./components/CollectLogsDialog";
import {
  OcrCaptureDialog,
  type OcrPrefill,
} from "./components/OcrCaptureDialog";
import { AutoOcrCapture } from "./components/AutoOcrCapture";
import { buildManualMissionDraft } from "@shared/ocrManualMission";

import {
  dropoffGroups,
  grandTotalRemaining,
  activeStopCount,
  routeEdges,
  routeStopCount,
  isTerminal,
  shouldShowLogBanner,
} from "./lib/selectors";

const EMPTY_REFERENCE: ReferenceData = {
  commodities: [],
  terminals: [],
  ships: [],
};

// ============================================================================
// App — the top-level shell. Owns the app MODE (cargo | salvage | mining),
// applies the matching theme to <html data-mode>, and routes to the cargo
// tracker (the existing, unchanged CargoApp), the salvage shell, or the mining
// shell. Mode is read once on mount from window.api and persisted on every
// switch, so it survives a restart. Each mode keeps an entirely separate
// component tree — switching mode unmounts one and mounts another, so no mode
// touches another's state.
// ============================================================================

/** The single-control cycle order for the mode switcher. */
const MODE_CYCLE: AppMode[] = ["cargo", "salvage", "mining"];

/** Next mode in the cycle (cargo -> salvage -> mining -> cargo). */
function nextMode(cur: AppMode): AppMode {
  const i = MODE_CYCLE.indexOf(cur);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length];
}

export function App(): React.JSX.Element {
  // null while we read the persisted mode on mount — render nothing rather than
  // flash one mode then snap to another on a one-tick delay.
  const [mode, setMode] = useState<AppMode | null>(null);

  // Read the persisted mode once, then keep <html data-mode> in sync with it.
  // Also subscribe to MODE_CHANGED so this window stays consistent if the mode
  // is changed elsewhere (the broadcast is the same value we set locally, so
  // this is a harmless echo for self-initiated switches and a correctness hook
  // for any future cross-window switch).
  useEffect(() => {
    void window.api.getMode().then((m) => {
      setMode(m);
      applyTheme(m);
    });
    const unsub = window.api.onModeChanged((m) => {
      setMode(m);
      applyTheme(m);
    });
    return () => unsub();
  }, []);

  const toggleMode = (): void => {
    setMode((cur) => {
      const next: AppMode = nextMode(cur ?? "cargo");
      applyTheme(next);
      // Persist; the resolved value from main is authoritative but identical.
      void window.api.setMode(next);
      return next;
    });
  };

  if (mode === null)
    return <div style={{ height: "100%", background: "var(--bg)" }} />;

  // The active-mode shell. The auto-update banner wraps ALL THREE so a downloaded
  // update is surfaced in cargo, salvage, AND mining mode (subscription lives in
  // UpdateGate, above the shell, so switching mode never drops the notification).
  const shell =
    mode === "salvage" ? (
      <SalvageShell onToggleMode={toggleMode} />
    ) : mode === "mining" ? (
      <MiningShell onToggleMode={toggleMode} />
    ) : (
      <CargoApp onToggleMode={toggleMode} />
    );

  return <UpdateGate>{shell}</UpdateGate>;
}

// ============================================================================
// UpdateGate — app-level, mode-agnostic host for the NON-FORCED update banner.
// ----------------------------------------------------------------------------
// Subscribes to the `update:status` push ONCE (above the mode shells) and renders
// the dismissible UpdateBanner above whatever shell is active. The banner never
// blocks the UI and never installs on its own: "Later" dismisses for the session
// (the downloaded update stays on disk), "Restart & Update" calls installUpdate().
//
// State machine off the pushed UpdateStatus:
//   - progress    -> show "Downloading… NN%" (subtle, no buttons).
//   - downloaded  -> show "vX.Y.Z ready — [Restart & Update] [Later]".
//   - checking/none/available/error -> render nothing (available means "found,
//     downloading"; the progress event drives the visible state).
// A session-scoped `dismissed` flag hides the ready banner after "Later" without
// touching the downloaded update. A fresh `downloaded` for a new version resets it.
// ============================================================================
function UpdateGate({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsub = window.api.onUpdateStatus((status: UpdateStatus) => {
      switch (status.state) {
        case "progress":
          setDownloadPercent(status.percent);
          break;
        case "downloaded":
          // Download finished — clear the progress view, surface the ready CTA,
          // and re-arm the banner (a new ready version overrides a prior "Later").
          setDownloadPercent(null);
          setReadyVersion(status.version);
          setDismissed(false);
          break;
        case "checking":
        case "available":
        case "none":
        case "error":
          // Nothing user-facing for these — checking/finding nothing is normal,
          // and 'available' just means a download has started (progress follows).
          break;
      }
    });
    return () => unsub();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      {!dismissed && (
        <UpdateBanner
          downloadPercent={downloadPercent}
          readyVersion={readyVersion}
          onInstall={() => void window.api.installUpdate()}
          onDismiss={() => setDismissed(true)}
        />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

// ============================================================================
// CargoApp — the original SC Cargo Tracker, unchanged except it now receives an
// `onToggleMode` callback to feed the top-left switcher in its TopBar. All cargo
// state, selectors and interactions are exactly as before.
// ============================================================================
function CargoApp({
  onToggleMode,
}: {
  onToggleMode: () => void;
}): React.JSX.Element {
  // --- server-backed state (via window.api) ---
  // `missions` = the full list (drives History). `activeMissions` = the store's
  // current-session, non-terminal set (drives the Mission List + by-dropoff), so
  // stale historical hauls never appear as active.
  const [missions, setMissions] = useState<Mission[]>([]);
  const [activeMissions, setActiveMissions] = useState<Mission[]>([]);
  const [logStatus, setLogStatus] = useState<LogStatus | null>(null);
  const [logPathInfo, setLogPathInfo] = useState<LogPathInfo | null>(null);
  const [reference, setReference] = useState<ReferenceData>(EMPTY_REFERENCE);
  const [currentLocation, setCurrentLocation] = useState<string | null>(null);
  // Selected ship slug (Phase A). Read on boot; persisted on every change.
  const [selectedShipSlug, setSelectedShipSlug] = useState<string | null>(null);
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  // Transient inline message (e.g. picked a folder with no Game.log).
  const [toast, setToast] = useState<string | null>(null);
  // Whether the always-on-top "next stop" overlay window is open (Phase D).
  // Read on mount and kept in sync via onOverlayStateChanged so the pin button
  // reflects the overlay closing itself via its own unpin control.
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  // EXPERIMENTAL OCR contract capture (Phase F). Opt-in; default false. When off
  // the capture entry point is hidden. Read on mount; toggled from the gear panel.
  const [ocrEnabled, setOcrEnabled] = useState(false);
  // EXPERIMENTAL Auto OCR Capture (Phase 3). Opt-in; default false; meaningful
  // only when ocrEnabled. Read on mount; toggled from the gear panel. Drives the
  // AutoOcrCapture host (subscribes to OCR_AUTO_REQUEST from main).
  const [autoOcrCapture, setAutoOcrCapture] = useState(false);

  // --- local UI state ---
  const [tab, setTab] = useState<TabKey>("dropoff");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  // When true, the Manual Add → OCR create-new dialog is open: an OcrCaptureDialog
  // in create-new mode that, on Apply, mints a NEW manual mission from the capture
  // (gated on ocrEnabled, like the other OCR entry points). Cancel creates nothing.
  const [showManualOcr, setShowManualOcr] = useState(false);
  const [showCollectLogs, setShowCollectLogs] = useState(false);
  // When set, the MANUAL OCR capture/review dialog is open. The dialog now opens
  // its target dropdown EMPTY (no preselect) and self-captures on mount.
  const [ocrCaptureFor, setOcrCaptureFor] = useState<{
    missionId: string | null;
  } | null>(null);
  // When set, the AUTO path (Phase 3) has a pre-filled OCR result awaiting human
  // review. Opens the SAME OcrCaptureDialog pre-filled (no silent write). Only one
  // review dialog is shown at a time; the auto host defers if one is already open.
  const [autoOcrReview, setAutoOcrReview] = useState<OcrPrefill | null>(null);
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [showDelivered, setShowDelivered] = useState(true);
  const [scanlines, setScanlines] = useState(true);

  // --- subscribe to the bridge ---
  useEffect(() => {
    const api = window.api;
    const refresh = (): void => {
      void api.listMissions().then(setMissions);
      void api.listActiveMissions().then(setActiveMissions);
    };
    refresh();
    void api.getLogStatus().then(setLogStatus);
    void api.getLogPathInfo().then(setLogPathInfo);
    void api.getReferenceData().then(setReference);
    void api.getCurrentLocation().then(setCurrentLocation);
    void api.getSelectedShip().then(setSelectedShipSlug);
    void api.getOverlayState().then((s) => setOverlayEnabled(s.enabled));
    void api.getOcrEnabled().then(setOcrEnabled);
    void api.getAutoOcrCapture().then(setAutoOcrCapture);

    const unsubs = [
      api.onOverlayStateChanged((s) => setOverlayEnabled(s.enabled)),
      // A change to the mission set affects both the full list AND the active
      // subset — re-pull both so the Mission List/by-dropoff stay in sync.
      api.onMissionsChanged(() => refresh()),
      api.onLogStatusChanged((status) => {
        setLogStatus(status);
        // The resolved path / found-state can change with connection (e.g. the
        // game created Game.log) — keep the gear panel's display in sync.
        void api.getLogPathInfo().then(setLogPathInfo);
      }),
      api.onCurrentLocationChanged(setCurrentLocation),
      api.onBackfillProgress((p) => {
        setBackfill(p);
        if (p.done) window.setTimeout(() => setBackfill(null), 700);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Auto-dismiss the error toast after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // --- derived ---
  // By-dropoff aggregates the ACTIVE set only (current session, non-terminal),
  // matching the store's dropoffGroups rule so stale historical hauls are excluded.
  const groups = useMemo(
    () => dropoffGroups(activeMissions, currentLocation),
    [activeMissions, currentLocation],
  );
  const grandTotal = useMemo(() => grandTotalRemaining(groups), [groups]);
  const activeStops = useMemo(() => activeStopCount(groups), [groups]);
  // Resolve the persisted ship slug to a ShipReference from the bundled snapshot.
  // null when unset or the slug no longer matches a ship (e.g. after a patch).
  const selectedShip = useMemo(
    () => reference.ships.find((s) => s.slug === selectedShipSlug) ?? null,
    [reference.ships, selectedShipSlug],
  );
  // ROUTE tab badge = number of distinct stops (union of pickup + dropoff
  // locations) across active hauls. Same active set as the By-Dropoff view.
  const routeStops = useMemo(
    () => routeStopCount(routeEdges(activeMissions)),
    [activeMissions],
  );
  // Live active missions keyed by id, so By-Dropoff can resolve a LegRef back to
  // its {mission, leg} for inline editing (single source of truth — no leg data
  // is duplicated into the selector).
  const activeMissionsById = useMemo(
    () => new Map(activeMissions.map((m) => [m.id, m])),
    [activeMissions],
  );
  const terminalCount = useMemo(
    () => missions.filter(isTerminal).length,
    [missions],
  );
  const knownGivers = useMemo(
    () =>
      Array.from(new Set(missions.map((m) => m.giver).filter(Boolean))).sort(),
    [missions],
  );

  const selected = selectedId
    ? (missions.find((m) => m.id === selectedId) ?? null)
    : null;
  // Empty State shows only when there is genuinely nothing to show on ANY tab
  // (no active missions AND no history). With history-only data we still render
  // the tabs so the user can reach the History view.
  const hasMissions = missions.length > 0;
  // Show the top warning strip when the resolved Game.log can't be found. Driven
  // off the existing logPathInfo/logStatus state (re-evaluated on the change /
  // log-status events the effect above already subscribes to) — no new plumbing.
  const showLogBanner = shouldShowLogBanner(logPathInfo, logStatus);

  const pad = density === "compact" ? 12 : 18;
  const gap = density === "compact" ? 10 : 16;

  // --- interactions (all persist via window.api) ---
  const toggleLeg = (
    missionId: string,
    legId: string,
    completed: boolean,
  ): void => {
    void window.api.updateMission(missionId, { legs: [{ legId, completed }] });
  };

  // Edit a leg's token-suppressed fields (commodity / SCU / location). Each edit
  // persists immediately and the store stamps manual_override so a later
  // historical replay can't clobber it. Once location + SCU are set, the leg
  // flows into the By-Dropoff aggregation.
  const editLeg = (
    missionId: string,
    legId: string,
    patch: { commodity?: string; scuTotal?: number; location?: string | null },
  ): void => {
    void window.api.updateMission(missionId, {
      legs: [{ legId, ...patch }],
    });
  };

  // Set a partial delivered amount on a leg (Phase B1). Persists scuDelivered
  // WITHOUT touching `completed` — a value strictly between 0 and scuTotal is the
  // partial state. The store stamps manual_override (any leg patch is a user
  // action), so historical replay can't clobber the partial.
  const setDelivered = (
    missionId: string,
    legId: string,
    scuDelivered: number,
  ): void => {
    void window.api.updateMission(missionId, {
      legs: [{ legId, scuDelivered }],
    });
  };

  // Add a new pickup/dropoff leg to an existing mission (Multi-to-Single /
  // Single-to-Multi hauls, or log-suppressed missions). The store generates the
  // leg id, defaults the fields blank, and stamps manual_override. The user then
  // fills commodity/SCU/location in the freshly-rendered EditableLegRow.
  const addLeg = (missionId: string, kind: LegKind): void => {
    void window.api.updateMission(missionId, { addLegs: [{ kind }] });
  };

  // Remove a leg from a mission. By-Dropoff + progress recompute via the
  // missions:changed broadcast that updateMission triggers.
  const removeLeg = (missionId: string, legId: string): void => {
    void window.api.updateMission(missionId, { removeLegIds: [legId] });
  };

  // TOGGLE every matching leg of `kind` at this location + commodity. If all of
  // them are already done -> un-do them; otherwise mark the remaining ones done.
  // Shared by By-Dropoff (kind 'dropoff' = delivered) and the ROUTE tab's pickup
  // column (kind 'pickup' = collected). Pickup completion IS tracked: the store's
  // objectiveCompleted sets a leg's `completed` regardless of kind, and the leg
  // patch in updateMission is kind-agnostic — so the same toggle works for both.
  // Only active missions feed these views, so iterate that set.
  const checkOffLineOf = (
    kind: LegKind,
    location: string,
    commodity: string,
  ): void => {
    const matching = (l: Mission["legs"][number]): boolean =>
      l.kind === kind && l.location === location && l.commodity === commodity;

    const all = activeMissions.flatMap((m) =>
      m.legs.filter(matching).map((l) => ({ mission: m, leg: l })),
    );
    if (all.length === 0) return;

    // If every matching leg is already done -> un-do all; else complete the
    // not-yet-done ones. (Toggle semantics, matching the CommodityLine intent.)
    const allDone = all.every(({ leg }) => leg.completed);
    const target = allDone ? false : true;

    for (const m of activeMissions) {
      const legs = m.legs.filter((l) => matching(l) && l.completed !== target);
      if (legs.length === 0) continue;
      void window.api.updateMission(m.id, {
        legs: legs.map((l) => ({ legId: l.id, completed: target })),
      });
    }
  };

  // Existing By-Dropoff check-off (dropoff legs) — unchanged behavior.
  const checkOffLine = (location: string, commodity: string): void =>
    checkOffLineOf("dropoff", location, commodity);

  // ROUTE tab pickup-column check-off (pickup legs = "collected").
  const checkOffPickup = (location: string, commodity: string): void =>
    checkOffLineOf("pickup", location, commodity);

  const setPayout = (missionId: string, payout: number): void => {
    // Manual edit -> treat as confirmed (SPEC §10 delta 3).
    void window.api.updateMission(missionId, {
      payout,
      payoutConfidence: "confirmed",
    });
  };
  // Set the full contract reward (Phase B2) that drives the partial-payout
  // estimate. Independent of the actual logged `payout`. null clears it.
  const setReward = (missionId: string, reward: number | null): void => {
    void window.api.updateMission(missionId, { reward });
  };
  const setNotes = (missionId: string, notes: string): void => {
    void window.api.updateMission(missionId, { notes });
  };
  const abandon = (missionId: string): void => {
    void window.api.abandonMission(missionId);
    setSelectedId(null);
  };
  // Manual "Mark complete" escape hatch. Reuses the existing updateMission status
  // path (no new IPC); the store stamps terminal_source='manual' so a later leg
  // recompute can't silently downgrade it. Moving to 'complete' also slides the
  // mission from the Active list into History (status drives both views).
  const markComplete = (missionId: string): void => {
    void window.api.updateMission(missionId, { status: "complete" });
    setSelectedId(null);
  };
  const saveManual = (input: ManualMissionInput): void => {
    void window.api.addMission(input);
    setShowForm(false);
  };

  // Manual Add → OCR (create-new): create a NEW manual mission from a reviewed
  // OCR capture and return its id so the OcrCaptureDialog can populate it via the
  // existing applyOcr/reward path. Called ONLY on the dialog's Apply (never on
  // Cancel), so no orphan empty mission is left behind. The draft is created with
  // EMPTY legs (buildManualMissionDraft) — applyOcr inserts the reviewed legs
  // fresh, keeping the SCU/null hardening + convergence path unchanged.
  const createManualFromOcr = async (title: string): Promise<string> => {
    const mission = await window.api.addMission(buildManualMissionDraft(title));
    return mission.id;
  };

  // Persist a ship selection (Phase A). Optimistic local update + persist; the
  // resolved slug from main is authoritative but identical. null clears it.
  const selectShip = (slug: string | null): void => {
    setSelectedShipSlug(slug);
    void window.api.setSelectedShip(slug);
  };

  // Toggle the always-on-top overlay window (Phase D). Main returns + broadcasts
  // the resulting state; we set it optimistically and the broadcast confirms.
  const toggleOverlay = (): void => {
    void window.api.toggleOverlay().then((s) => setOverlayEnabled(s.enabled));
  };

  // Toggle the EXPERIMENTAL OCR contract-capture feature (Phase F). Persists via
  // settings; when turned off, also close any open capture dialog so the hidden
  // entry point can't linger. Optimistic + confirmed by the saved value.
  const toggleOcr = (): void => {
    const next = !ocrEnabled;
    setOcrEnabled(next);
    if (!next) {
      setOcrCaptureFor(null);
      setAutoOcrReview(null);
    }
    void window.api.setOcrEnabled(next).then(setOcrEnabled);
  };

  // Toggle EXPERIMENTAL Auto OCR Capture (Phase 3). Persists via settings. The
  // host is gated on (ocrEnabled && autoOcrCapture), so turning OCR off neutralizes
  // it without changing this flag. Optimistic + confirmed by the saved value.
  const toggleAutoOcr = (): void => {
    const next = !autoOcrCapture;
    setAutoOcrCapture(next);
    void window.api.setAutoOcrCapture(next).then(setAutoOcrCapture);
  };

  const clearActive = (): void => {
    const n = activeMissions.length;
    const ok = window.confirm(
      `Clear the active Mission List?\n\nThis removes ${n} active mission${
        n === 1 ? "" : "s"
      } from the current session. Completed/abandoned hauls in History are kept.`,
    );
    if (!ok) return;
    void window.api.clearActiveMissions();
    setSelectedId(null);
  };

  // Open the native folder picker to choose a custom StarCitizen \LIVE\ folder.
  // On success the main process saves the setting, retargets the watcher, and
  // returns fresh path info (missions stream back in via missions:changed). On a
  // folder with no Game.log it returns an error we surface inline; nothing
  // changes. A cancel is a no-op.
  const pickLogFolder = (): void => {
    void window.api.pickLogFolder().then((res) => {
      if (res.outcome === "ok" && res.info) {
        setLogPathInfo(res.info);
        setToast(null);
        // The watcher restarted + re-backfilled; pull a fresh status snapshot.
        void window.api.getLogStatus().then(setLogStatus);
      } else if (res.outcome === "error") {
        setToast(res.error ?? "Could not use that folder.");
      }
      // "canceled" -> no-op.
    });
  };

  const resetAll = (): void => {
    const ok = window.confirm(
      "Reset ALL data?\n\nThis wipes every mission, leg, payout and fine from the database, then re-runs the logbackups backfill under the corrected rules. The UEX reference cache is kept. This cannot be undone.",
    );
    if (!ok) return;
    void window.api.resetAllData();
    setSelectedId(null);
    setTab("missions");
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      <TopBar
        logStatus={logStatus}
        logPathInfo={logPathInfo}
        currentLocation={currentLocation}
        onResync={() => void window.api.startBackfill()}
        onReset={resetAll}
        onPickLogFolder={pickLogFolder}
        onCollectLogs={() => setShowCollectLogs(true)}
        onToggleMode={onToggleMode}
        overlayEnabled={overlayEnabled}
        onToggleOverlay={toggleOverlay}
        ocrEnabled={ocrEnabled}
        onToggleOcr={toggleOcr}
        onOcrCapture={() => setOcrCaptureFor({ missionId: null })}
        autoOcrCapture={autoOcrCapture}
        onToggleAutoOcr={toggleAutoOcr}
      />

      {/* Log-not-found warning strip — full width, directly under the TopBar and
          above the TabBar so it's the first thing seen. Auto-hides the moment
          Game.log is found (predicate re-evaluates on the same events). Reuses
          the shared pickLogFolder handler (gear panel / 'Locate Game.log'). */}
      {showLogBanner && (
        <LogMissingBanner
          logPathInfo={logPathInfo}
          onPickLogFolder={pickLogFolder}
        />
      )}

      <TabBar
        active={tab}
        counts={{
          dropoff: activeStops,
          route: routeStops,
          missions: activeMissions.length,
          history: terminalCount,
        }}
        totalRemaining={grandTotal}
        onChange={setTab}
      />

      {/* density + display toggles strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "6px 18px",
          flex: "none",
          borderBottom: "1px solid var(--border)",
          background: "rgba(7,12,16,0.3)",
        }}
      >
        {/* Ship picker — Cargo mode, first item in the toolbar row, immediately
            to the LEFT of the DENSITY control. Wired to the same
            selectedShipSlug/selectShip state the capacity bar + route reads. */}
        <ShipPicker
          ships={reference.ships}
          selectedSlug={selectedShipSlug}
          onSelect={selectShip}
        />
        <ToggleChip
          label="DENSITY"
          value={density === "compact" ? "COMPACT" : "COMFORTABLE"}
          onClick={() =>
            setDensity((d) => (d === "compact" ? "comfortable" : "compact"))
          }
        />
        <ToggleChip
          label="DELIVERED"
          value={showDelivered ? "SHOWN" : "HIDDEN"}
          active={showDelivered}
          onClick={() => setShowDelivered((v) => !v)}
        />
        <ToggleChip
          label="SCANLINES"
          value={scanlines ? "ON" : "OFF"}
          active={scanlines}
          onClick={() => setScanlines((v) => !v)}
        />
      </div>

      {/* Hold-capacity bar (Phase A) — under the tab toolbar, visible on the
          By-Dropoff and ROUTE tabs only. Compares total SCU still to deliver
          against the selected ship's hold. Muted prompt when no ship is set. */}
      {hasMissions && (tab === "dropoff" || tab === "route") && (
        <CapacityBar totalRemaining={grandTotal} ship={selectedShip} />
      )}

      {/* main content */}
      <main
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {scanlines && (
          <div
            className="sc-scanlines"
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              zIndex: 6,
              background:
                "repeating-linear-gradient(0deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.16) 3px)",
              mixBlendMode: "multiply",
            }}
          />
        )}

        <div
          style={{
            position: "absolute",
            inset: 0,
            overflowY: "auto",
            padding: pad,
          }}
        >
          {!hasMissions ? (
            <EmptyState onAddManually={() => setShowForm(true)} />
          ) : tab === "dropoff" ? (
            <DropoffView
              groups={groups}
              grandTotal={grandTotal}
              activeStops={activeStops}
              gap={gap}
              showDelivered={showDelivered}
              missionsById={activeMissionsById}
              reference={reference}
              onCheckOff={checkOffLine}
              onEditLeg={editLeg}
              onSetDelivered={setDelivered}
              onOpenMission={setSelectedId}
            />
          ) : tab === "route" ? (
            <RouteView
              activeMissions={activeMissions}
              currentLocation={currentLocation}
              gap={gap}
              dropoffs={groups}
              shipCapacity={selectedShip?.scu ?? null}
              onCheckOffPickup={checkOffPickup}
              onCheckOffDropoff={checkOffLine}
            />
          ) : tab === "missions" ? (
            <MissionListView
              missions={activeMissions}
              gap={gap}
              onToggleLeg={toggleLeg}
              onOpenDetails={setSelectedId}
              onManualAdd={() => setShowForm(true)}
              onClearActive={clearActive}
            />
          ) : (
            <HistoryView missions={missions} onOpenMission={setSelectedId} />
          )}
        </div>

        {/* slide-in detail panel */}
        {selected && (
          <MissionDetailPanel
            mission={selected}
            reference={reference}
            onClose={() => setSelectedId(null)}
            onToggleLeg={(legId, completed) =>
              toggleLeg(selected.id, legId, completed)
            }
            onEditLeg={(legId, patch) => editLeg(selected.id, legId, patch)}
            onSetDelivered={(legId, scuDelivered) =>
              setDelivered(selected.id, legId, scuDelivered)
            }
            onAddLeg={(kind) => addLeg(selected.id, kind)}
            onRemoveLeg={(legId) => removeLeg(selected.id, legId)}
            onSetPayout={(payout) => setPayout(selected.id, payout)}
            onSetReward={(reward) => setReward(selected.id, reward)}
            onSetNotes={(notes) => setNotes(selected.id, notes)}
            onAbandon={() => abandon(selected.id)}
            onMarkComplete={() => markComplete(selected.id)}
            ocrEnabled={ocrEnabled}
            onOcrCapture={() => setOcrCaptureFor({ missionId: selected.id })}
          />
        )}

        {/* manual entry modal */}
        {showForm && (
          <ManualEntryForm
            reference={reference}
            knownGivers={knownGivers}
            onCancel={() => setShowForm(false)}
            onSave={saveManual}
            ocrEnabled={ocrEnabled}
            onOcrCapture={() => setShowManualOcr(true)}
          />
        )}

        {/* Manual Add → OCR (create-new). The SAME capture/review dialog in
            create-new mode: on Apply it mints a NEW manual mission from the
            capture (createManualFromOcr) then applies the reviewed objectives +
            reward to it. Gated on ocrEnabled. Cancel leaves no mission behind. */}
        {ocrEnabled && showManualOcr && (
          <OcrCaptureDialog
            missions={activeMissions}
            reference={reference}
            onCreateManualMission={createManualFromOcr}
            onClose={() => {
              setShowManualOcr(false);
              setShowForm(false);
            }}
          />
        )}

        {/* Collect Logs / Report a Problem dialog */}
        {showCollectLogs && (
          <CollectLogsDialog onClose={() => setShowCollectLogs(false)} />
        )}

        {/* EXPERIMENTAL OCR contract capture + review dialog (Phase F). Only
            reachable when ocrEnabled (the entry points are gated), and it never
            writes to a mission until the user confirms in its review step. The
            MANUAL dialog self-captures on mount and opens with an EMPTY target. */}
        {ocrEnabled && ocrCaptureFor && (
          <OcrCaptureDialog
            missions={activeMissions}
            reference={reference}
            preselectMissionId={ocrCaptureFor.missionId}
            onClose={() => setOcrCaptureFor(null)}
          />
        )}

        {/* AUTO review dialog (Phase 3): the SAME dialog, pre-filled with the
            headless auto-capture result, opened for review. Suppressed while a
            manual dialog is open so the auto host's deferral guard holds (one
            review at a time). Nothing is written until the user clicks Apply. */}
        {ocrEnabled && autoOcrReview && !ocrCaptureFor && (
          <OcrCaptureDialog
            missions={activeMissions}
            reference={reference}
            prefill={autoOcrReview}
            onClose={() => setAutoOcrReview(null)}
          />
        )}

        {/* EXPERIMENTAL Auto OCR Capture host (Phase 3). Headless except for its
            transient notices/cues. Active only when both OCR + auto are on; it
            subscribes to the OCR_AUTO_REQUEST push, runs the calibrated pipeline,
            and OPENS the review dialog (no silent write). `reviewOpen` tells it a
            dialog is already up so it defers the new result. Fully guarded. */}
        <AutoOcrCapture
          enabled={ocrEnabled && autoOcrCapture}
          missions={activeMissions}
          reference={reference}
          reviewOpen={Boolean(ocrCaptureFor) || autoOcrReview !== null}
          onAutoReview={setAutoOcrReview}
        />

        {/* backfill overlay */}
        {backfill && <BackfillOverlay progress={backfill} />}

        {/* error toast (e.g. chosen folder has no Game.log) */}
        {toast && (
          <div
            role="alert"
            onClick={() => setToast(null)}
            style={{
              position: "absolute",
              bottom: 18,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 30,
              maxWidth: 520,
              padding: "12px 16px",
              background: "rgba(28,10,14,0.98)",
              border: "1px solid rgba(255,107,107,0.5)",
              color: "var(--danger)",
              fontFamily: "var(--font-display)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-line",
              boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
              cursor: "pointer",
            }}
          >
            {toast}
          </div>
        )}
      </main>
    </div>
  );
}

// Small inline toggle chip for the display-controls strip.
function ToggleChip({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: string;
  active?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="sc-ghost-btn"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "4px 10px",
        background: "transparent",
        border: "1px solid var(--border)",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: 9,
          letterSpacing: 1.5,
          color: "var(--muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: active === false ? "var(--muted-done)" : "var(--primary)",
        }}
      >
        {value}
      </span>
    </button>
  );
}
