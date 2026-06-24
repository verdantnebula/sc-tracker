// ============================================================================
// MiningShell — the SC Mining reference shell (MISC industrial-blue theme).
// ----------------------------------------------------------------------------
// The mining analog of SalvageShell/CargoApp: it owns the mining UI state and
// talks only to the mining:reference IPC channel (read-only reference) PLUS the
// shared current-location channel (reused from cargo) so it can surface what's
// minable NEAR the player's last-known location. No DB writes, no log
// correlation — it loads the bundled reference once and renders one of three
// tabs:
//   1. LOOKUP (hero) — look up a metal by name (or, secondarily, by scan value).
//   2. ROCK VALUES — the full 26-rock scan-signature table.
//   3. DEPOSITS — the 61-material location reference.
// Location awareness (resolveBody/areaRegionsForBody) lets ROCK VALUES + DEPOSITS
// filter/highlight what's minable in the player's current system body, degrading
// gracefully to "show everything" when the location is unknown/unmappable.
// Everything is token-driven so the MISC azure theme skins it for free.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { MiningReferenceData, LogPathInfo } from "@shared/types";
import { resolveBody, areaRegionsForBody } from "@shared/miningArea";
import { MiningTopBar } from "./MiningTopBar";
import { MiningScanLookupView } from "./mining/MiningScanLookupView";
import { MiningRockValuesView } from "./mining/MiningRockValuesView";
import { MiningDepositsView } from "./mining/MiningDepositsView";
import { CollectLogsDialog } from "./CollectLogsDialog";

/** The mining tabs. */
export type MiningTab = "scan" | "rocks" | "deposits";

const MINING_TABS: { key: MiningTab; label: string }[] = [
  { key: "scan", label: "LOOKUP" },
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
  // Reused from cargo: the player's last-known humanized location (the last
  // terminal/inventory event). Drives the "minerals near you" awareness.
  const [currentLocation, setCurrentLocation] = useState<string | null>(null);
  // Whether ROCK VALUES + DEPOSITS hide everything that isn't minable near the
  // player. Off by default; ignored (forced to "show all") when no body resolves.
  const [onlyNearMe, setOnlyNearMe] = useState(false);
  // Whether the shared always-on-top overlay window is open (Phase D). The same
  // single overlay is shared across Cargo/Mining; its content follows the active
  // mode. Read on mount + kept in sync via onOverlayStateChanged so the pin
  // button reflects the overlay closing itself (or a toggle from the cargo bar).
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  // Shared app-wide state for the gear popover: the resolved Game.log path info.
  const [logPathInfo, setLogPathInfo] = useState<LogPathInfo | null>(null);
  // Collect Logs / Report a Problem dialog (now reachable from the gear).
  const [showCollectLogs, setShowCollectLogs] = useState(false);

  // Load the bundled mining reference once, and subscribe to the SAME current-
  // location plumbing the cargo renderer uses. Read-only on mining data, but it
  // also reads the shared Game.log path info + log status for the gear popover.
  useEffect(() => {
    const api = window.api;
    void api.getMiningReference().then(setReference);
    void api.getCurrentLocation().then(setCurrentLocation);
    void api.getOverlayState().then((s) => setOverlayEnabled(s.enabled));
    void api.getLogPathInfo().then(setLogPathInfo);
    const unsubs = [
      api.onCurrentLocationChanged(setCurrentLocation),
      api.onOverlayStateChanged((s) => setOverlayEnabled(s.enabled)),
      // Keep the gear's path display in sync (mirrors CargoApp/SalvageShell).
      api.onLogStatusChanged(() => {
        void api.getLogPathInfo().then(setLogPathInfo);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // Toggle the shared overlay window open/closed (same IPC the cargo TopBar
  // uses). Optimistic + confirmed by the broadcast.
  const toggleOverlay = (): void => {
    void window.api.toggleOverlay().then((s) => setOverlayEnabled(s.enabled));
  };

  // Open the native folder picker to choose a custom StarCitizen \LIVE\ folder.
  // Mirrors CargoApp.pickLogFolder: on success refresh the gear's path info.
  const pickLogFolder = (): void => {
    void window.api.pickLogFolder().then((res) => {
      if (res.outcome === "ok" && res.info) setLogPathInfo(res.info);
      // "canceled"/"error" -> no-op (mining has no error toast surface).
    });
  };

  // Reset ALL data — same destructive, confirmed reset the cargo bar exposes.
  const resetAll = (): void => {
    const ok = window.confirm(
      "Reset ALL data?\n\nThis wipes every mission, leg, payout and fine from the database, then re-runs the logbackups backfill under the corrected rules. The UEX reference cache is kept. This cannot be undone.",
    );
    if (!ok) return;
    void window.api.resetAllData();
  };

  // Resolve location -> body -> the set of deposit regions that count as "near".
  const body = useMemo(() => resolveBody(currentLocation), [currentLocation]);
  const areaRegions = useMemo(() => areaRegionsForBody(body), [body]);
  // The area filter is only meaningful when a body resolved. If not, force
  // "show all" so we never hide everything (graceful degrade).
  const areaActive = body !== null;
  const effectiveOnlyNearMe = areaActive && onlyNearMe;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      <MiningTopBar
        onToggleMode={onToggleMode}
        body={body}
        overlayEnabled={overlayEnabled}
        onToggleOverlay={toggleOverlay}
        logPathInfo={logPathInfo}
        onPickLogFolder={pickLogFolder}
        onResync={() => void window.api.startBackfill()}
        onReset={resetAll}
        onCollectLogs={() => setShowCollectLogs(true)}
      />

      {showCollectLogs && (
        <CollectLogsDialog onClose={() => setShowCollectLogs(false)} />
      )}

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

      {/* "Near you" strip — only for the area-aware tabs (ROCK VALUES + DEPOSITS).
          Shows the resolved body + the only-near-me toggle, or a muted hint when
          no location is detected. The LOOKUP tab is location-agnostic. */}
      {(tab === "rocks" || tab === "deposits") && (
        <NearYouStrip
          body={body}
          currentLocation={currentLocation}
          onlyNearMe={effectiveOnlyNearMe}
          canFilter={areaActive}
          onToggle={() => setOnlyNearMe((v) => !v)}
        />
      )}

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
            <MiningRockValuesView
              reference={reference}
              areaRegions={areaRegions}
              onlyNearMe={effectiveOnlyNearMe}
            />
          ) : (
            <MiningDepositsView
              reference={reference}
              areaRegions={areaRegions}
              onlyNearMe={effectiveOnlyNearMe}
            />
          )}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NearYouStrip — the location-awareness indicator + filter toggle. Sits under
// the tab bar on the area-aware tabs. Degrades to a muted "no location" hint
// (never hides everything) when the body can't be resolved.
// ---------------------------------------------------------------------------

function NearYouStrip({
  body,
  currentLocation,
  onlyNearMe,
  canFilter,
  onToggle,
}: {
  body: string | null;
  currentLocation: string | null;
  onlyNearMe: boolean;
  canFilter: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "8px 18px",
        flex: "none",
        borderBottom: "1px solid var(--border)",
        background: "rgba(22,34,50,0.35)",
      }}
    >
      {canFilter ? (
        <>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontFamily: "var(--font-display)",
              fontSize: 11,
              letterSpacing: 1,
              color: "var(--muted)",
            }}
          >
            NEAR YOU
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                fontWeight: 700,
                color: "var(--primary)",
              }}
            >
              {body}
            </span>
          </span>
          <button
            onClick={onToggle}
            aria-pressed={onlyNearMe}
            className="sc-ghost-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "5px 11px",
              background: onlyNearMe ? "rgba(52,224,224,0.10)" : "transparent",
              border: `1px solid ${
                onlyNearMe ? "var(--primary)" : "var(--border-strong)"
              }`,
              color: onlyNearMe ? "var(--primary)" : "var(--text-2)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: 11,
              letterSpacing: 0.5,
              cursor: "pointer",
            }}
          >
            {onlyNearMe ? "✓ " : ""}Only show what's minable near me
          </button>
          <span
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 11,
              color: "var(--muted-done)",
            }}
          >
            (based on last known location, body-level)
          </span>
        </>
      ) : (
        <span
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 12,
            color: "var(--muted-done)",
          }}
        >
          {currentLocation
            ? `Location "${currentLocation}" not mapped to a body — showing all.`
            : "No location detected — showing all."}
        </span>
      )}
    </div>
  );
}
