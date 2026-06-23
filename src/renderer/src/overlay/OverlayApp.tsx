// ============================================================================
// OverlayApp.tsx — the always-on-top "next stop" overlay (Phase D).
// ----------------------------------------------------------------------------
// A compact, dark, glanceable card that floats over the game (frameless,
// transparent, always-on-top window — see electron/main.ts createOverlay). It
// answers ONE question: "where next, and what do I unload there?".
//
// Data: the SAME window.api bridge + the SAME pure selectors the main app uses
// (nextStops -> dropoffGroups + optimizeRoute), so the two windows can never
// disagree. Checking off a cargo line calls window.api.updateMission exactly like
// the main UI; both windows refresh via onMissionsChanged. No new persisted state.
//
// CAVEAT (documented for the release notes): a TRUE exclusive-fullscreen game can
// paint over an always-on-top window — recommend Borderless/Windowed in SC so the
// overlay stays visible. (Electron alwaysOnTop can't beat exclusive fullscreen.)
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type { Mission, AppMode, ReferenceData, LegKind } from "@shared/types";
import { applyTheme } from "../lib/theme";
import { nextStops, type NextStop } from "../lib/nextStop";
import { fmt } from "../lib/selectors";

const EMPTY_REFERENCE: ReferenceData = {
  commodities: [],
  terminals: [],
  ships: [],
};

export function OverlayApp(): React.JSX.Element {
  const [mode, setMode] = useState<AppMode | null>(null);
  const [activeMissions, setActiveMissions] = useState<Mission[]>([]);
  const [currentLocation, setCurrentLocation] = useState<string | null>(null);
  const [reference, setReference] = useState<ReferenceData>(EMPTY_REFERENCE);
  const [selectedShipSlug, setSelectedShipSlug] = useState<string | null>(null);
  // Which stop in the ordered list the overlay is showing. "Next ▸" advances it;
  // it's clamped against the live stop count whenever the data changes.
  const [stopIndex, setStopIndex] = useState(0);

  // --- subscribe to the bridge (mirrors the main app's wiring, trimmed) ---
  useEffect(() => {
    const api = window.api;
    void api.getMode().then((m) => {
      setMode(m);
      applyTheme(m);
    });
    void api.listActiveMissions().then(setActiveMissions);
    void api.getCurrentLocation().then(setCurrentLocation);
    void api.getReferenceData().then(setReference);
    void api.getSelectedShip().then(setSelectedShipSlug);

    const unsubs = [
      api.onMissionsChanged(
        () => void api.listActiveMissions().then(setActiveMissions),
      ),
      api.onCurrentLocationChanged(setCurrentLocation),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const selectedShip = useMemo(
    () => reference.ships.find((s) => s.slug === selectedShipSlug) ?? null,
    [reference.ships, selectedShipSlug],
  );

  // The ordered remaining dropoff stops (first = next). Same derivation as the
  // ROUTE tab / By-Dropoff view, so the overlay and main window agree.
  const stops = useMemo(
    () =>
      mode === "cargo"
        ? nextStops(activeMissions, currentLocation, { ship: selectedShip })
            .stops
        : [],
    [mode, activeMissions, currentLocation, selectedShip],
  );

  // Clamp the viewed index whenever the stop set shrinks (deliveries clear
  // stops). If it ran off the end, snap back to the last stop (or 0 when empty).
  useEffect(() => {
    if (stopIndex >= stops.length) setStopIndex(Math.max(0, stops.length - 1));
  }, [stops.length, stopIndex]);

  const stop: NextStop | null = stops[stopIndex] ?? stops[0] ?? null;

  // Check off a cargo line: mark EVERY matching dropoff leg at this location +
  // commodity delivered (same toggle semantics + IPC path as the main UI's
  // By-Dropoff check-off). The missions:changed broadcast refreshes both windows.
  const checkOffLine = (location: string, commodity: string): void => {
    const kind: LegKind = "dropoff";
    const matching = (l: Mission["legs"][number]): boolean =>
      l.kind === kind && l.location === location && l.commodity === commodity;
    for (const m of activeMissions) {
      const legs = m.legs.filter((l) => matching(l) && !l.completed);
      if (legs.length === 0) continue;
      void window.api.updateMission(m.id, {
        legs: legs.map((l) => ({ legId: l.id, completed: true })),
      });
    }
  };

  const advance = (): void => {
    if (stops.length === 0) return;
    setStopIndex((i) => (i + 1) % stops.length);
  };

  // Unpin: closes the overlay (persists overlayEnabled=false in main). The main
  // window's pin button reflects this via onOverlayStateChanged.
  const unpin = (): void => {
    void window.api.toggleOverlay();
  };

  return (
    <div
      style={{
        height: "100vh",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        // Semi-opaque dark surface for legibility over the game; theme-tinted
        // border so cargo/salvage stay on-brand.
        background: "rgba(6, 11, 15, 0.92)",
        border: "1px solid var(--border-strong)",
        color: "var(--text)",
        fontFamily: "var(--font-body)",
        // The whole card is a drag handle (frameless window) EXCEPT interactive
        // controls, which opt back out with WebkitAppRegion: "no-drag".
        // @ts-expect-error -- non-standard Electron CSS property
        WebkitAppRegion: "drag",
        userSelect: "none",
      }}
    >
      <Header
        currentLocation={currentLocation}
        count={stops.length}
        index={stopIndex}
        onUnpin={unpin}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 10 }}>
        {mode === null ? null : mode === "salvage" ? (
          <Placeholder text="Overlay is Cargo-mode only." />
        ) : stop === null ? (
          <Placeholder text="No active stops — nothing to unload." />
        ) : (
          <StopCard stop={stop} onCheckOff={checkOffLine} />
        )}
      </div>

      {mode === "cargo" && stops.length > 1 && (
        <Footer index={stopIndex} count={stops.length} onNext={advance} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — NEXT STOP label + position chip + unpin control. Drag handle.
// ---------------------------------------------------------------------------

function Header({
  currentLocation,
  count,
  index,
  onUnpin,
}: {
  currentLocation: string | null;
  count: number;
  index: number;
  onUnpin: () => void;
}): React.JSX.Element {
  return (
    <header
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderBottom: "1px solid var(--border)",
        background:
          "linear-gradient(180deg, rgba(12,22,28,0.85), rgba(7,12,16,0.4))",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 10,
          letterSpacing: 1.5,
          color: "var(--primary)",
        }}
      >
        NEXT STOP
      </span>
      {count > 1 && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--muted)",
          }}
        >
          {index + 1}/{count}
        </span>
      )}
      <div style={{ flex: 1 }} />
      <span
        title="Current location"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-2)",
          maxWidth: 130,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {currentLocation ?? "—"}
      </span>
      <button
        onClick={onUnpin}
        aria-label="Hide overlay"
        title="Hide overlay"
        style={{
          // @ts-expect-error -- non-standard Electron CSS property
          WebkitAppRegion: "no-drag",
          flex: "none",
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "1px solid var(--border-strong)",
          color: "var(--text-2)",
          fontSize: 13,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// StopCard — the destination + its checkable cargo lines.
// ---------------------------------------------------------------------------

function StopCard({
  stop,
  onCheckOff,
}: {
  stop: NextStop;
  onCheckOff: (location: string, commodity: string) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 16,
            color: stop.needsLocation
              ? "var(--secondary)"
              : "var(--text-bright)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {stop.needsLocation ? "Set destination" : stop.location}
        </span>
        {stop.isCurrentLocation && (
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 9,
              letterSpacing: 1,
              color: "var(--success)",
              border: "1px solid var(--success)",
              padding: "1px 5px",
            }}
          >
            YOU ARE HERE
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--primary)",
          }}
        >
          {fmt(stop.scuRemaining)} SCU
        </span>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 4,
          // @ts-expect-error -- non-standard Electron CSS property
          WebkitAppRegion: "no-drag",
        }}
      >
        {stop.lines.map((line) => (
          <button
            key={line.commodity}
            onClick={() => onCheckOff(stop.location, line.commodity)}
            title="Mark delivered"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "5px 8px",
              background: "rgba(52,224,224,0.05)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              fontFamily: "var(--font-body)",
              fontSize: 12,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span
              aria-hidden
              style={{
                flex: "none",
                width: 14,
                height: 14,
                border: "1px solid var(--border-strong)",
                color: "var(--primary)",
                fontSize: 11,
                lineHeight: "13px",
                textAlign: "center",
              }}
            >
              {" "}
            </span>
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {line.commodity}
            </span>
            <span
              style={{
                flex: "none",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-2)",
              }}
            >
              {fmt(line.scuRemaining)} SCU
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer — "Next ▸" advances to the following stop (wraps). Only shown with 2+.
// ---------------------------------------------------------------------------

function Footer({
  index,
  count,
  onNext,
}: {
  index: number;
  count: number;
  onNext: () => void;
}): React.JSX.Element {
  return (
    <footer
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 10px",
        borderTop: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--muted)",
        }}
      >
        {count - 1} more {count - 1 === 1 ? "stop" : "stops"}
        {index > 0 ? ` · viewing ${index + 1}/${count}` : ""}
      </span>
      <button
        onClick={onNext}
        title="Show the next stop"
        style={{
          // @ts-expect-error -- non-standard Electron CSS property
          WebkitAppRegion: "no-drag",
          padding: "5px 12px",
          background: "var(--primary)",
          border: "1px solid var(--primary)",
          color: "#04181a",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: 1,
          cursor: "pointer",
        }}
      >
        Next ▸
      </button>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Placeholder — muted message for Salvage mode / no active stops.
// ---------------------------------------------------------------------------

function Placeholder({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 10,
        color: "var(--muted)",
        fontFamily: "var(--font-display)",
        fontSize: 12,
        letterSpacing: 0.5,
      }}
    >
      {text}
    </div>
  );
}
