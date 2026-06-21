// ============================================================================
// SalvageShell — the SC Salvage Tracker shell (Drake-Interplanetary theme).
// ----------------------------------------------------------------------------
// Owns all salvage UI state and wires every interaction to the typed window.api
// bridge (the salvage:* channels). It is the salvage analog of CargoApp: it keeps
// its own component tree + state entirely separate from cargo, talking only over
// the salvage IPC channels, and refreshes off the salvage:runs:changed broadcast.
//
// It renders the shared TopBar (Cargo<->Salvage switcher) + the salvage TabBar
// (Active Run / Sell & Split / History / Reference), then the real view for the
// active tab. Everything is token-driven so the Drake theme skins it for free.
// ============================================================================

import { useEffect, useState } from "react";
import type { SalvageRun, SalvageReferenceData } from "@shared/types";
import { SalvageTopBar } from "./SalvageTopBar";
import { SalvageActiveRunView } from "./salvage/SalvageActiveRunView";
import { SalvageSellSplitView } from "./salvage/SalvageSellSplitView";
import { SalvageHistoryView } from "./salvage/SalvageHistoryView";
import { SalvageReferenceView } from "./salvage/SalvageReferenceView";
import { CollectLogsDialog } from "./CollectLogsDialog";

/** The salvage tabs. */
export type SalvageTab = "run" | "split" | "history" | "reference";

const SALVAGE_TABS: { key: SalvageTab; label: string }[] = [
  { key: "run", label: "ACTIVE RUN" },
  { key: "split", label: "SELL & SPLIT" },
  { key: "history", label: "HISTORY" },
  { key: "reference", label: "REFERENCE" },
];

// Empty reference until the bundled snapshot loads (mirrors CargoApp's
// EMPTY_REFERENCE) — keeps every view total-safe before the first fetch resolves.
const EMPTY_SALVAGE_REFERENCE: SalvageReferenceData = {
  ships: [],
  components: [],
  materialPrices: { rmcPerScu: 0, cmatPerScu: 0 },
  haulers: [],
};

export function SalvageShell({
  onToggleMode,
}: {
  /** Switch back to cargo mode (wired by App; persists via window.api). */
  onToggleMode: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<SalvageTab>("run");
  const [showCollectLogs, setShowCollectLogs] = useState(false);

  // --- server-backed state (via window.api salvage channels) ---
  const [runs, setRuns] = useState<SalvageRun[]>([]);
  const [activeRun, setActiveRun] = useState<SalvageRun | null>(null);
  const [reference, setReference] = useState<SalvageReferenceData>(
    EMPTY_SALVAGE_REFERENCE,
  );

  // Subscribe to the salvage bridge. A single salvage:runs:changed broadcast
  // feeds both the runs list (History) and the active run (Active Run / Split),
  // so we recompute the active run from the pushed snapshot — no extra round-trip.
  useEffect(() => {
    const api = window.api;
    const applySnapshot = (list: SalvageRun[]): void => {
      setRuns(list);
      setActiveRun(list.find((r) => r.status === "active") ?? null);
    };

    void api.listSalvageRuns().then(applySnapshot);
    void api.getSalvageReference().then(setReference);

    const unsub = api.onSalvageRunsChanged(applySnapshot);
    return () => unsub();
  }, []);

  // --- mutations (all persist via window.api; UI refreshes off the broadcast) ---
  const createRun = (): void => {
    void window.api.createSalvageRun({});
  };
  const updateRun = (
    patch: Parameters<typeof window.api.updateSalvageRun>[1],
  ): void => {
    if (!activeRun) return;
    void window.api.updateSalvageRun(activeRun.id, patch);
  };
  const addStripped = (
    input: Parameters<typeof window.api.addStrippedComponent>[1],
  ): void => {
    if (!activeRun) return;
    void window.api.addStrippedComponent(activeRun.id, input);
  };
  const updateStripped = (
    componentId: string,
    patch: Parameters<typeof window.api.updateStrippedComponent>[2],
  ): void => {
    if (!activeRun) return;
    void window.api.updateStrippedComponent(activeRun.id, componentId, patch);
  };
  const removeStripped = (componentId: string): void => {
    if (!activeRun) return;
    void window.api.removeStrippedComponent(activeRun.id, componentId);
  };
  const completeRun = (): void => {
    if (!activeRun) return;
    void window.api.completeSalvageRun(activeRun.id);
    setTab("history");
  };
  const abandonRun = (): void => {
    if (!activeRun) return;
    void window.api.updateSalvageRun(activeRun.id, { status: "abandoned" });
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
      <SalvageTopBar
        onToggleMode={onToggleMode}
        onCollectLogs={() => setShowCollectLogs(true)}
      />

      {showCollectLogs && (
        <CollectLogsDialog onClose={() => setShowCollectLogs(false)} />
      )}

      {/* Hazard-stripe accent bar — Drake's industrial signature. */}
      <div
        aria-hidden
        style={{
          height: 6,
          flex: "none",
          background: "var(--hazard-stripe)",
          opacity: 0.85,
        }}
      />

      {/* Salvage TabBar — blockier than cargo's. */}
      <div
        style={{
          height: 50,
          flex: "none",
          display: "flex",
          alignItems: "stretch",
          borderBottom: "2px solid var(--border-strong)",
          background: "var(--surface)",
        }}
      >
        {SALVAGE_TABS.map((t) => {
          const isActive = tab === t.key;
          const count =
            t.key === "history"
              ? runs.filter((r) => r.status !== "active").length
              : t.key === "run" && activeRun
                ? activeRun.stripped.length
                : null;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 26px",
                background: isActive ? "var(--surface-2)" : "transparent",
                border: "none",
                borderRight: "1px solid var(--border)",
                cursor: "pointer",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: 14,
                letterSpacing: 1,
                color: isActive ? "var(--text-bright)" : "var(--muted)",
              }}
            >
              {t.label}
              {count != null && count > 0 && (
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    fontWeight: 700,
                    color: isActive ? "var(--primary)" : "var(--muted-done)",
                  }}
                >
                  {count}
                </span>
              )}
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: -2,
                  height: 3,
                  background: isActive ? "var(--primary)" : "transparent",
                }}
              />
            </button>
          );
        })}
      </div>

      {/* main content — the real view for the active tab */}
      <main
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflowY: "auto",
            padding: 18,
          }}
        >
          {tab === "run" ? (
            <SalvageActiveRunView
              run={activeRun}
              reference={reference}
              onCreateRun={createRun}
              onUpdateRun={updateRun}
              onAddStripped={addStripped}
              onUpdateStripped={updateStripped}
              onRemoveStripped={removeStripped}
              onCompleteRun={completeRun}
              onAbandonRun={abandonRun}
            />
          ) : tab === "split" ? (
            <SalvageSellSplitView
              run={activeRun}
              reference={reference}
              onUpdateStripped={updateStripped}
            />
          ) : tab === "history" ? (
            <SalvageHistoryView runs={runs} reference={reference} />
          ) : (
            <SalvageReferenceView reference={reference} />
          )}
        </div>
      </main>
    </div>
  );
}
