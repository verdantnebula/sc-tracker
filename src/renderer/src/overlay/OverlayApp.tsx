// ============================================================================
// OverlayApp.tsx — the always-on-top, MODE-AWARE overlay (Phase D + Mining).
// ----------------------------------------------------------------------------
// A compact, dark, glanceable card that floats over the game (frameless,
// transparent, always-on-top window — see electron/main.ts createOverlay). It is
// a SINGLE shared window whose CONTENT follows the active app mode:
//
//   cargo   -> the "next stop" panel (where next, what to unload there)
//   mining  -> the Mining panel (SCAN ID reverse-lookup + minerals NEAR YOU)
//   salvage -> a minimal placeholder (no overlay for Salvage yet)
//
// Data: the SAME window.api bridge + the SAME pure selectors the main app uses,
// so the two windows can never disagree. Mode comes from window.api.getMode()
// plus the MODE_CHANGED subscription (mirrors the main App), so switching modes
// in the main window swaps the overlay's content + theme LIVE.
//
// CAVEAT (documented for the release notes): a TRUE exclusive-fullscreen game can
// paint over an always-on-top window — recommend Borderless/Windowed in SC so the
// overlay stays visible. (Electron alwaysOnTop can't beat exclusive fullscreen.)
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import type {
  Mission,
  AppMode,
  ReferenceData,
  LegKind,
  MiningReferenceData,
} from "@shared/types";
import { resolveBody, areaRegionsForBody } from "@shared/miningArea";
import { applyTheme } from "../lib/theme";
import { nextStops, type NextStop } from "../lib/nextStop";
import { fmt as cargoFmt } from "../lib/selectors";
import {
  searchRocks,
  rarityColor,
  fmt as miningFmt,
  areaScannableRocks,
  type ScanMatch,
} from "../lib/miningSelectors";

const EMPTY_REFERENCE: ReferenceData = {
  commodities: [],
  terminals: [],
  ships: [],
};

const EMPTY_MINING_REFERENCE: MiningReferenceData = {
  rocks: [],
  deposits: [],
};

// How many "near you" rocks the compact overlay lists before "+N more".
const NEAR_YOU_CAP = 6;

export function OverlayApp(): React.JSX.Element {
  const [mode, setMode] = useState<AppMode | null>(null);
  const [currentLocation, setCurrentLocation] = useState<string | null>(null);

  // --- subscribe to the bridge (mirrors the main app's wiring) ---
  // Mode + current location are shared across every panel, so they live here in
  // the shell. Mode drives BOTH which panel renders AND the theme (data-mode),
  // and the MODE_CHANGED subscription swaps both live.
  useEffect(() => {
    const api = window.api;
    void api.getMode().then((m) => {
      setMode(m);
      applyTheme(m);
    });
    void api.getCurrentLocation().then(setCurrentLocation);

    const unsubs = [
      api.onModeChanged((m) => {
        setMode(m);
        applyTheme(m);
      }),
      api.onCurrentLocationChanged(setCurrentLocation),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

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
        // border so cargo/mining/salvage stay on-brand (data-mode tokens).
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
      {mode === "mining" ? (
        <MiningOverlay currentLocation={currentLocation} onUnpin={unpin} />
      ) : mode === "salvage" ? (
        <PlaceholderOverlay
          title="SALVAGE"
          text="No overlay for Salvage."
          onUnpin={unpin}
        />
      ) : mode === "cargo" ? (
        <CargoOverlay currentLocation={currentLocation} onUnpin={unpin} />
      ) : (
        // mode === null: still reading persisted mode — render the chrome only.
        <PlaceholderOverlay title="" text="" onUnpin={unpin} />
      )}
    </div>
  );
}

// ===========================================================================
// CARGO panel — the original "next stop" overlay, unchanged in behavior.
// ===========================================================================

function CargoOverlay({
  currentLocation,
  onUnpin,
}: {
  currentLocation: string | null;
  onUnpin: () => void;
}): React.JSX.Element {
  const [activeMissions, setActiveMissions] = useState<Mission[]>([]);
  const [reference, setReference] = useState<ReferenceData>(EMPTY_REFERENCE);
  const [selectedShipSlug, setSelectedShipSlug] = useState<string | null>(null);
  // Which stop in the ordered list the overlay is showing. "Next ▸" advances it;
  // it's clamped against the live stop count whenever the data changes.
  const [stopIndex, setStopIndex] = useState(0);

  useEffect(() => {
    const api = window.api;
    void api.listActiveMissions().then(setActiveMissions);
    void api.getReferenceData().then(setReference);
    void api.getSelectedShip().then(setSelectedShipSlug);

    const unsub = api.onMissionsChanged(
      () => void api.listActiveMissions().then(setActiveMissions),
    );
    return () => unsub();
  }, []);

  const selectedShip = useMemo(
    () => reference.ships.find((s) => s.slug === selectedShipSlug) ?? null,
    [reference.ships, selectedShipSlug],
  );

  // The ordered remaining dropoff stops (first = next). Same derivation as the
  // ROUTE tab / By-Dropoff view, so the overlay and main window agree.
  const stops = useMemo(
    () =>
      nextStops(activeMissions, currentLocation, { ship: selectedShip }).stops,
    [activeMissions, currentLocation, selectedShip],
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

  return (
    <>
      <Header
        title="NEXT STOP"
        position={stops.length > 1 ? `${stopIndex + 1}/${stops.length}` : null}
        chip={currentLocation ?? "—"}
        chipTitle="Current location"
        onUnpin={onUnpin}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 10 }}>
        {stop === null ? (
          <Centered text="No active stops — nothing to unload." />
        ) : (
          <StopCard stop={stop} onCheckOff={checkOffLine} />
        )}
      </div>

      {stops.length > 1 && (
        <Footer index={stopIndex} count={stops.length} onNext={advance} />
      )}
    </>
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
          {cargoFmt(stop.scuRemaining)} SCU
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
              {cargoFmt(line.scuRemaining)} SCU
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer — "Next ▸" advances to the following cargo stop (wraps). 2+ stops only.
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

// ===========================================================================
// MINING panel — unified SEARCH (radar value OR mineral name) + minerals NEAR
// YOU. The single box auto-detects: a number runs the scan-value reverse-lookup
// (lookupScan), text runs the mineral-name search (searchRocksByName). Both
// flows are dispatched by the tested pure helper searchRocks(); the overlay just
// renders the unified result list. NEAR YOU is unchanged.
// ===========================================================================

// How many search results the compact overlay lists before "+N more".
const SEARCH_CAP = 4;

function MiningOverlay({
  currentLocation,
  onUnpin,
}: {
  currentLocation: string | null;
  onUnpin: () => void;
}): React.JSX.Element {
  const [reference, setReference] = useState<MiningReferenceData>(
    EMPTY_MINING_REFERENCE,
  );
  // The single search box: EITHER a radar value the player reads off their
  // scanner OR a mineral name (free text so paste + partial input work). The
  // tested searchRocks() dispatcher decides which path to run.
  const [query, setQuery] = useState("");

  useEffect(() => {
    void window.api.getMiningReference().then(setReference);
  }, []);

  // UNIFIED SEARCH: numeric query -> scan-value reverse-lookup (lookupScan);
  // text query -> mineral-name search (searchRocksByName). Empty query yields
  // the NAME path with all rocks, which we suppress in the UI (show a hint) so
  // the compact overlay isn't flooded before the user types.
  const result = useMemo(
    () => searchRocks(query, reference.rocks),
    [query, reference.rocks],
  );
  const hasQuery = query.trim().length > 0;

  // NEAR YOU: resolve location -> body -> area regions -> the scannable rocks
  // whose deposit is minable here (shared tested selector). [] when no body
  // resolved; the panel then degrades to a muted hint.
  const body = useMemo(() => resolveBody(currentLocation), [currentLocation]);
  const areaRegions = useMemo(() => areaRegionsForBody(body), [body]);
  const nearYou = useMemo(
    () => areaScannableRocks(reference.rocks, reference.deposits, areaRegions),
    [reference.rocks, reference.deposits, areaRegions],
  );

  const shown = nearYou.slice(0, NEAR_YOU_CAP);
  const more = nearYou.length - shown.length;

  return (
    <>
      <Header
        title="MINING"
        position={null}
        chip={body ?? "—"}
        chipTitle="Current body (near you)"
        onUnpin={onUnpin}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          // @ts-expect-error -- non-standard Electron CSS property
          WebkitAppRegion: "no-drag",
        }}
      >
        {/* SEARCH — one box: a number runs the scan-value reverse-lookup, text
            runs the mineral-name search. searchRocks() picks the path. */}
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <SectionLabel>SEARCH</SectionLabel>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="scan value or mineral name…"
            aria-label="Scan value or mineral name"
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "var(--window, rgba(0,0,0,0.35))",
              border: "1px solid var(--border-strong)",
              color: "var(--text-bright)",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              padding: "6px 9px",
              outline: "none",
            }}
          />
          {!hasQuery ? (
            <Hint>Enter a scanner value or a mineral name.</Hint>
          ) : (
            <SearchResults result={result} query={query} />
          )}
        </section>

        {/* NEAR YOU — scannable rocks minable in the player's current area. */}
        <section style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <SectionLabel>
            NEAR YOU
            {body && (
              <span
                style={{
                  marginLeft: 7,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--primary)",
                  letterSpacing: 0,
                }}
              >
                {body}
              </span>
            )}
          </SectionLabel>

          {body === null ? (
            <Hint>
              {currentLocation
                ? `"${currentLocation}" not mapped to a body — showing nothing here.`
                : "No location — showing nothing here."}
            </Hint>
          ) : nearYou.length === 0 ? (
            <Hint>No scannable rocks mapped to {body}.</Hint>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {shown.map(({ rock }) => (
                <NearYouRow
                  key={rock.name}
                  name={rock.name}
                  rarity={rock.rarity}
                  baseValue={rock.scanValues[0] ?? 0}
                  topValue={rock.scanValues[rock.scanValues.length - 1] ?? 0}
                />
              ))}
              {more > 0 && <Hint>+{more} more</Hint>}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// SearchResults — the unified result list for the single SEARCH box. Renders
// value-matches (with tier) or name-matches (with a compact scan-signature
// hint) depending on which path searchRocks() took, capped with "+N more".
// ---------------------------------------------------------------------------

function SearchResults({
  result,
  query,
}: {
  result: ReturnType<typeof searchRocks>;
  query: string;
}): React.JSX.Element {
  // Branch on the discriminant FIRST so `matches` narrows to the right element
  // type in each arm (ScanMatch[] vs MiningRock[]).
  if (result.mode === "value") {
    if (result.matches.length === 0) {
      return (
        <Hint>
          No rock matches {miningFmt(Number(query.replace(/[, ]/g, "")))}.
        </Hint>
      );
    }
    const shown = result.matches.slice(0, SEARCH_CAP);
    const more = result.matches.length - shown.length;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {shown.map((m) => (
          <ScanMatchRow key={`${m.name}-${m.tier}`} match={m} />
        ))}
        {more > 0 && <Hint>+{more} more</Hint>}
      </div>
    );
  }

  if (result.matches.length === 0) {
    return <Hint>No mineral matches “{query.trim()}”.</Hint>;
  }
  const shown = result.matches.slice(0, SEARCH_CAP);
  const more = result.matches.length - shown.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {shown.map((rock) => (
        <NameMatchRow
          key={rock.name}
          name={rock.name}
          rarity={rock.rarity}
          baseValue={rock.scanValues[0] ?? 0}
          topValue={rock.scanValues[rock.scanValues.length - 1] ?? 0}
        />
      ))}
      {more > 0 && <Hint>+{more} more</Hint>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NameMatchRow — one name-search result: name + rarity + a compact scan-
// signature hint (base value, and the base–top range when distinct). Mirrors
// NearYouRow's shape so the value vs name result rows read consistently.
// ---------------------------------------------------------------------------

function NameMatchRow({
  name,
  rarity,
  baseValue,
  topValue,
}: {
  name: string;
  rarity: string;
  baseValue: number;
  topValue: number;
}): React.JSX.Element {
  const sig =
    topValue > baseValue
      ? `${miningFmt(baseValue)}–${miningFmt(topValue)}`
      : miningFmt(baseValue);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        background: "rgba(52,224,224,0.05)",
        border: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          flex: 1,
          fontWeight: 700,
          fontSize: 13,
          color: "var(--text-bright)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      <RarityPill rarity={rarity} />
      <span
        title="Scan signature (tier 1 – tier 6)"
        style={{
          flex: "none",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-2)",
        }}
      >
        {sig}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScanMatchRow — one matched rock: name + rarity (rarity-colored) + tier.
// ---------------------------------------------------------------------------

function ScanMatchRow({ match }: { match: ScanMatch }): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        background: "rgba(52,224,224,0.05)",
        border: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          flex: 1,
          fontWeight: 700,
          fontSize: 13,
          color: "var(--text-bright)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {match.name}
      </span>
      <RarityPill rarity={match.rarity} />
      <span
        title={`Matched scan tier ${match.tier} (value ${miningFmt(match.tierValue)})`}
        style={{
          flex: "none",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--muted)",
        }}
      >
        T{match.tier} · {miningFmt(match.tierValue)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NearYouRow — one in-area rock: name + rarity + a compact scan-signature hint
// (its tier-1 base value, and tier-6 top value when distinct).
// ---------------------------------------------------------------------------

function NearYouRow({
  name,
  rarity,
  baseValue,
  topValue,
}: {
  name: string;
  rarity: string;
  baseValue: number;
  topValue: number;
}): React.JSX.Element {
  const sig =
    topValue > baseValue
      ? `${miningFmt(baseValue)}–${miningFmt(topValue)}`
      : miningFmt(baseValue);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      <RarityPill rarity={rarity} />
      <span
        title="Scan signature (tier 1 – tier 6)"
        style={{
          flex: "none",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-2)",
        }}
      >
        {sig}
      </span>
    </div>
  );
}

function RarityPill({ rarity }: { rarity: string }): React.JSX.Element {
  return (
    <span
      style={{
        flex: "none",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: 8,
        letterSpacing: 1,
        color: rarityColor(rarity),
        border: `1px solid ${rarityColor(rarity)}`,
        padding: "1px 5px",
        whiteSpace: "nowrap",
      }}
    >
      {rarity.toUpperCase()}
    </span>
  );
}

function SectionLabel({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: 10,
        letterSpacing: 1.5,
        color: "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      style={{
        fontFamily: "var(--font-body)",
        fontSize: 11,
        color: "var(--muted-done, var(--muted))",
      }}
    >
      {children}
    </span>
  );
}

// ===========================================================================
// Shared chrome — Header (drag handle) + Centered/Placeholder messages.
// ===========================================================================

function Header({
  title,
  position,
  chip,
  chipTitle,
  onUnpin,
}: {
  title: string;
  /** e.g. "2/5" position chip, or null to hide. */
  position: string | null;
  /** Right-aligned context chip (current location / body). */
  chip: string;
  chipTitle: string;
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
        {title}
      </span>
      {position && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--muted)",
          }}
        >
          {position}
        </span>
      )}
      <div style={{ flex: 1 }} />
      <span
        title={chipTitle}
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
        {chip}
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

function PlaceholderOverlay({
  title,
  text,
  onUnpin,
}: {
  title: string;
  text: string;
  onUnpin: () => void;
}): React.JSX.Element {
  return (
    <>
      <Header
        title={title}
        position={null}
        chip="—"
        chipTitle="Current mode"
        onUnpin={onUnpin}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: 10 }}>
        {text ? <Centered text={text} /> : null}
      </div>
    </>
  );
}

function Centered({ text }: { text: string }): React.JSX.Element {
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
