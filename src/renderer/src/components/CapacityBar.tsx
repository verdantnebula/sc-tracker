// ============================================================================
// CapacityBar — Phase A. A thin hold-capacity bar shown in the Cargo header
// area (under the tab toolbar; visible on By-Dropoff + ROUTE). It compares the
// total SCU still to deliver against the selected ship's hold via the pure
// capacityStatus helper.
//
//   • no ship selected -> a muted "Pick a ship to see capacity" (no bar).
//   • ship selected     -> a fill bar (green ok / amber warn / red over),
//                          a "<total> / <cap> SCU" label, and when over an
//                          "over by <overflow> SCU · needs <trips> trips" note.
//
// Purely token-driven (var(--success)/var(--secondary)/var(--danger)); inherits
// the active cargo theme. The whole capacity calc lives in capacity.ts (tested).
// ============================================================================

import type { ShipReference } from "@shared/types";
import { fmt } from "../lib/selectors";
import { capacityStatus, type CapacityTier } from "../lib/capacity";

/** Map a capacity tier to its fill color token. */
function tierColor(tier: CapacityTier): string {
  switch (tier) {
    case "over":
      return "var(--danger)";
    case "warn":
      return "var(--secondary)";
    default:
      return "var(--success)";
  }
}

export function CapacityBar({
  totalRemaining,
  ship,
}: {
  /** Total SCU still to deliver (grandTotalRemaining). */
  totalRemaining: number;
  /** The selected ship, or null when none is chosen. */
  ship: ShipReference | null;
}): React.JSX.Element {
  const shipScu = ship ? ship.scu : null;
  const status = capacityStatus(totalRemaining, shipScu);

  // No ship -> muted prompt, no bar.
  if (status.tier === "none" || !ship) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 18px",
          borderBottom: "1px solid var(--border)",
          background: "rgba(7,12,16,0.3)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 10,
            letterSpacing: 1.5,
            color: "var(--muted)",
          }}
        >
          HOLD
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted-done)",
          }}
        >
          Pick a ship to see capacity
        </span>
      </div>
    );
  }

  const color = tierColor(status.tier);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 18px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(7,12,16,0.3)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: 10,
          letterSpacing: 1.5,
          color: "var(--muted)",
          flex: "none",
        }}
      >
        HOLD
      </span>

      {/* fill bar */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={ship.scu}
        aria-valuenow={Math.min(totalRemaining, ship.scu)}
        aria-label="Hold capacity used"
        style={{
          flex: 1,
          height: 8,
          minWidth: 60,
          background: "rgba(86,180,200,0.10)",
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${(status.usedPct * 100).toFixed(1)}%`,
            height: "100%",
            background: color,
            boxShadow: `0 0 8px ${color}`,
            transition: "width 160ms ease",
          }}
        />
      </div>

      {/* numeric label */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-bright)",
          flex: "none",
          whiteSpace: "nowrap",
        }}
      >
        {fmt(totalRemaining)} / {fmt(ship.scu)} SCU
      </span>

      {/* over-capacity note */}
      {status.tier === "over" && (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 0.5,
            color: "var(--danger)",
            flex: "none",
            whiteSpace: "nowrap",
          }}
        >
          over by {fmt(status.overflowScu)} SCU · needs {status.trips} trips
        </span>
      )}
    </div>
  );
}
