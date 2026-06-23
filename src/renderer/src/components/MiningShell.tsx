// ============================================================================
// MiningShell — the SC Mining reference shell (MISC industrial-blue theme).
// ----------------------------------------------------------------------------
// The mining analog of SalvageShell/CargoApp: it owns the mining UI state and
// talks only to the mining:reference IPC channel. Mining mode is currently a
// READ-ONLY reference surface (no DB writes, no log correlation — that's a later
// phase), so there are no mutations: it loads the bundled reference once and
// renders one of three tabs:
//   1. SCAN LOOKUP (hero) — type a scanner value, identify the rock + tier +
//      where it's found.
//   2. ROCK VALUES — the full 26-rock scan-signature table.
//   3. DEPOSITS — the 61-material location reference.
// Everything is token-driven so the MISC azure theme skins it for free.
// ============================================================================

import { useEffect, useState } from "react";
import type { MiningReferenceData } from "@shared/types";
import { MiningTopBar } from "./MiningTopBar";
import { MiningScanLookupView } from "./mining/MiningScanLookupView";
import { MiningRockValuesView } from "./mining/MiningRockValuesView";
import { MiningDepositsView } from "./mining/MiningDepositsView";

/** The mining tabs. */
export type MiningTab = "scan" | "rocks" | "deposits";

const MINING_TABS: { key: MiningTab; label: string }[] = [
  { key: "scan", label: "SCAN LOOKUP" },
  { key: "rocks", label: "ROCK VALUES" },
  { key: "deposits", label: "DEPOSITS" },
];

// Empty reference until the bundled snapshot loads (mirrors SalvageShell) —
// keeps every view total-safe before the first fetch resolves.
const EMPTY_MINING_REFERENCE: MiningReferenceData = {
  rocks: [],
  deposits: [],
};

export function MiningShell({
  onToggleMode,
}: {
  /** Advance the app mode (wired by App; persists via window.api). */
  onToggleMode: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<MiningTab>("scan");
  const [reference, setReference] = useState<MiningReferenceData>(
    EMPTY_MINING_REFERENCE,
  );

  // Load the bundled mining reference once. Read-only: no broadcasts to subscribe
  // to, no mutations — this is purely a lookup surface.
  useEffect(() => {
    void window.api.getMiningReference().then(setReference);
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
      <MiningTopBar onToggleMode={onToggleMode} />

      {/* Hazard-stripe accent bar — cool azure industrial signature. */}
      <div
        aria-hidden
        style={{
          height: 6,
          flex: "none",
          background: "var(--hazard-stripe)",
          opacity: 0.85,
        }}
      />

      {/* Mining TabBar — mirrors the salvage tab bar. */}
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
        {MINING_TABS.map((t) => {
          const isActive = tab === t.key;
          const count =
            t.key === "rocks"
              ? reference.rocks.length
              : t.key === "deposits"
                ? reference.deposits.length
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
          {tab === "scan" ? (
            <MiningScanLookupView reference={reference} />
          ) : tab === "rocks" ? (
            <MiningRockValuesView reference={reference} />
          ) : (
            <MiningDepositsView reference={reference} />
          )}
        </div>
      </main>
    </div>
  );
}
