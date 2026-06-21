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

import { TopBar } from "./components/TopBar";
import { SalvageShell } from "./components/SalvageShell";
import { applyTheme } from "./lib/theme";
import { LogMissingBanner } from "./components/LogMissingBanner";
import { TabBar, type TabKey } from "./components/TabBar";
import { DropoffView } from "./components/DropoffView";
import { MissionListView } from "./components/MissionListView";
import { HistoryView } from "./components/HistoryView";
import { MissionDetailPanel } from "./components/MissionDetailPanel";
import { ManualEntryForm } from "./components/ManualEntryForm";
import { BackfillOverlay } from "./components/BackfillOverlay";
import { EmptyState } from "./components/EmptyState";
import { CollectLogsDialog } from "./components/CollectLogsDialog";

import {
  dropoffGroups,
  grandTotalRemaining,
  activeStopCount,
  isTerminal,
  shouldShowLogBanner,
} from "./lib/selectors";

const EMPTY_REFERENCE: ReferenceData = { commodities: [], terminals: [] };

// ============================================================================
// App — the top-level shell. Owns the app MODE (cargo | salvage), applies the
// matching theme to <html data-mode>, and routes to the cargo tracker (the
// existing, unchanged CargoApp) or the salvage shell. Mode is read once on
// mount from window.api and persisted on every switch, so it survives a restart.
// Cargo and salvage keep entirely separate component trees — switching mode
// unmounts one and mounts the other, so neither touches the other's state.
// ============================================================================
export function App(): React.JSX.Element {
  // null while we read the persisted mode on mount — render nothing rather than
  // flash cargo then snap to salvage (or vice versa) on a one-tick delay.
  const [mode, setMode] = useState<AppMode | null>(null);

  // Read the persisted mode once, then keep <html data-mode> in sync with it.
  useEffect(() => {
    void window.api.getMode().then((m) => {
      setMode(m);
      applyTheme(m);
    });
  }, []);

  const toggleMode = (): void => {
    setMode((cur) => {
      const next: AppMode = cur === "salvage" ? "cargo" : "salvage";
      applyTheme(next);
      // Persist; the resolved value from main is authoritative but identical.
      void window.api.setMode(next);
      return next;
    });
  };

  if (mode === null)
    return <div style={{ height: "100%", background: "var(--bg)" }} />;
  if (mode === "salvage") return <SalvageShell onToggleMode={toggleMode} />;
  return <CargoApp onToggleMode={toggleMode} />;
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
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  // Transient inline message (e.g. picked a folder with no Game.log).
  const [toast, setToast] = useState<string | null>(null);

  // --- local UI state ---
  const [tab, setTab] = useState<TabKey>("dropoff");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showCollectLogs, setShowCollectLogs] = useState(false);
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

    const unsubs = [
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

  const checkOffLine = (location: string, commodity: string): void => {
    // TOGGLE every matching dropoff leg at this location + commodity. If all of
    // them are already delivered, clicking UN-delivers them; otherwise it marks
    // the remaining ones delivered. Lets the user undo a mistaken/auto check.
    // Only active missions feed the by-dropoff view, so iterate that set.
    const matching = (l: Mission["legs"][number]): boolean =>
      l.kind === "dropoff" &&
      l.location === location &&
      l.commodity === commodity;

    const all = activeMissions.flatMap((m) =>
      m.legs.filter(matching).map((l) => ({ mission: m, leg: l })),
    );
    if (all.length === 0) return;

    // If every matching leg is already done -> un-deliver all; else deliver the
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

  const setPayout = (missionId: string, payout: number): void => {
    // Manual edit -> treat as confirmed (SPEC §10 delta 3).
    void window.api.updateMission(missionId, {
      payout,
      payoutConfidence: "confirmed",
    });
  };
  const setNotes = (missionId: string, notes: string): void => {
    void window.api.updateMission(missionId, { notes });
  };
  const abandon = (missionId: string): void => {
    void window.api.abandonMission(missionId);
    setSelectedId(null);
  };
  const saveManual = (input: ManualMissionInput): void => {
    void window.api.addMission(input);
    setShowForm(false);
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
        onManualAdd={() => setShowForm(true)}
        onReset={resetAll}
        onPickLogFolder={pickLogFolder}
        onCollectLogs={() => setShowCollectLogs(true)}
        onToggleMode={onToggleMode}
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
              onOpenMission={setSelectedId}
            />
          ) : tab === "missions" ? (
            <MissionListView
              missions={activeMissions}
              gap={gap}
              onToggleLeg={toggleLeg}
              onOpenDetails={setSelectedId}
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
            onAddLeg={(kind) => addLeg(selected.id, kind)}
            onRemoveLeg={(legId) => removeLeg(selected.id, legId)}
            onSetPayout={(payout) => setPayout(selected.id, payout)}
            onSetNotes={(notes) => setNotes(selected.id, notes)}
            onAbandon={() => abandon(selected.id)}
          />
        )}

        {/* manual entry modal */}
        {showForm && (
          <ManualEntryForm
            reference={reference}
            knownGivers={knownGivers}
            onCancel={() => setShowForm(false)}
            onSave={saveManual}
          />
        )}

        {/* Collect Logs / Report a Problem dialog */}
        {showCollectLogs && (
          <CollectLogsDialog onClose={() => setShowCollectLogs(false)} />
        )}

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
