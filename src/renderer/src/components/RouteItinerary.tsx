// RouteItinerary — the numbered "suggested order" panel shown when OPTIMIZE is on
// in the ROUTE tab. Renders the optimizer's `ordered` stops as a compact, draggable
// 1→2→3 list (kind + location + commodity·SCU), a relative "≈ distance" readout, a
// capacity-infeasible note when a ship is selected, and a trailing "UNSEQUENCED"
// group for stops the log never gave a position. Heuristic — labeled "suggested",
// never "optimal".
//
// Manual override: the user drags rows to reorder; the parent owns the order state
// (session-only, no settings plumbing). "Reset to suggested" reverts. Drag uses the
// native HTML5 DnD API — no new deps.
import { useState } from "react";
import type { Stop } from "../lib/routeOptimize";
import { fmt } from "../lib/selectors";

export function RouteItinerary({
  ordered,
  totalDistance,
  infeasibleCapacity,
  shipSelected,
  isManual,
  onReorder,
  onReset,
}: {
  /** Final display order (suggested or manually overridden). */
  ordered: Stop[];
  /** Raw path distance in position units — shown relatively, never absolute. */
  totalDistance: number;
  infeasibleCapacity: boolean;
  shipSelected: boolean;
  /** True when the user has dragged the order away from the suggestion. */
  isManual: boolean;
  /** Commit a new order (after a drag). */
  onReorder: (next: Stop[]) => void;
  /** Revert to the computed suggestion. */
  onReset: () => void;
}): React.JSX.Element {
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const sequenced = ordered.filter((s) => !s.missingPosition);
  const unsequenced = ordered.filter((s) => s.missingPosition);

  const handleDrop = (toIndex: number): void => {
    if (dragIndex == null || dragIndex === toIndex) {
      setDragIndex(null);
      return;
    }
    // Reorder within the sequenced span only; unsequenced stays pinned at the end.
    const next = [...sequenced];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorder(next.concat(unsequenced));
    setDragIndex(null);
  };

  if (ordered.length === 0) {
    return (
      <div
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 13,
          color: "var(--muted)",
          padding: "16px 6px",
        }}
      >
        No stops to sequence.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Readout strip: suggested/manual label + relative distance + capacity note. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1.5,
            color: "var(--primary)",
          }}
        >
          {isManual ? "MANUAL ORDER" : "SUGGESTED ORDER"}
        </span>
        {sequenced.length > 0 && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
            }}
            title="Relative path length in raw position units (lower is shorter)"
          >
            ≈ {fmt(Math.round(totalDistance))} dist
          </span>
        )}
        {isManual && (
          <button
            className="sc-ghost-btn"
            onClick={onReset}
            style={{
              padding: "3px 10px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 9,
              letterSpacing: 1,
              color: "var(--muted)",
            }}
          >
            RESET TO SUGGESTED
          </button>
        )}
      </div>

      {/* Capacity-infeasible note (only meaningful when a ship is selected). */}
      {shipSelected && infeasibleCapacity && (
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 12,
            color: "var(--warning, var(--secondary))",
            border: "1px solid var(--border)",
            borderRadius: 5,
            padding: "7px 9px",
            background: "var(--window)",
          }}
        >
          ⚠ This run can&apos;t be carried in one load — needs multiple trips or
          a reorder.
        </div>
      )}

      {/* Numbered, draggable sequenced stops. */}
      <ol
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {sequenced.map((s, i) => (
          <li
            key={s.id}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(i)}
            onDragEnd={() => setDragIndex(null)}
          >
            <StopRow stop={s} index={i + 1} dragging={dragIndex === i} />
          </li>
        ))}
      </ol>

      {/* Unsequenced (no position) trailing group. */}
      {unsequenced.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            borderTop: "1px dashed var(--border)",
            paddingTop: 8,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 10,
              letterSpacing: 1.5,
              color: "var(--muted)",
            }}
            title="These stops have no map position, so they can't be ordered by distance."
          >
            UNSEQUENCED ({unsequenced.length}) — no map position
          </span>
          {unsequenced.map((s) => (
            <StopRow key={s.id} stop={s} index={null} dragging={false} />
          ))}
        </div>
      )}

      <span
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 10.5,
          color: "var(--muted)",
        }}
      >
        Drag rows to reorder. Suggested order is a heuristic, not guaranteed
        optimal.
      </span>
    </div>
  );
}

// One itinerary row: order badge (or • for unsequenced), kind chip, location, and
// commodity·SCU. Amber for pickup, cyan for dropoff (matches the LIST columns).
function StopRow({
  stop,
  index,
  dragging,
}: {
  stop: Stop;
  index: number | null;
  dragging: boolean;
}): React.JSX.Element {
  const accent = stop.kind === "pickup" ? "var(--secondary)" : "var(--primary)";
  const kindLabel = stop.kind === "pickup" ? "PICK UP" : "DROP OFF";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 10px",
        background: "var(--card-grad)",
        border: `1px solid ${dragging ? accent : "var(--border)"}`,
        borderRadius: 6,
        opacity: dragging ? 0.6 : 1,
        cursor: index == null ? "default" : "grab",
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          flex: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          border: `1.5px solid ${accent}`,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 11,
          color: accent,
        }}
      >
        {index ?? "•"}
      </span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 9,
          letterSpacing: 1,
          color: accent,
          flex: "none",
          width: 56,
        }}
      >
        {kindLabel}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          color: "var(--text-bright)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={stop.location ?? "Unknown location"}
      >
        {stop.location ?? "Unknown location"}
      </span>
      <span
        style={{
          fontSize: 12,
          color: "var(--text)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: 140,
        }}
        title={stop.commodity || "(unknown)"}
      >
        {stop.commodity || "(unknown)"}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 12.5,
          color: "var(--text-bright)",
          flex: "none",
        }}
      >
        {fmt(stop.scu)}
      </span>
    </div>
  );
}
