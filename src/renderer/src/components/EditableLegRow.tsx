// EditableLegRow — detail-panel leg row with inline editing for token-suppressed
// fields (the intermittent objectiveDeclared bug leaves commodity/scuTotal/
// location blank). Combines the completion checkbox (as in LegRow) with editable
// commodity (datalist autocomplete over UEX commodities), SCU (number), and
// location (datalist over ALL UEX destinations + free text). Edits commit on
// change via onEditLeg; the store stamps manual_override so historical replay
// can't clobber them.
import { useEffect, useState } from "react";
import type { Leg, ReferenceData } from "@shared/types";
import { sortDestinations } from "@shared/location";
import { isLegIncomplete } from "../lib/selectors";

export function EditableLegRow({
  leg,
  reference,
  onToggle,
  onEditLeg,
  onRemove,
  canRemove = true,
}: {
  leg: Leg;
  reference: ReferenceData;
  onToggle: () => void;
  onEditLeg: (patch: {
    commodity?: string;
    scuTotal?: number;
    location?: string | null;
  }) => void;
  /** When provided, render a ✕ to delete this leg from the mission. */
  onRemove?: () => void;
  /** Disable the ✕ when removing would leave the mission with zero legs. */
  canRemove?: boolean;
}): React.JSX.Element {
  const isPickup = leg.kind === "pickup";
  const accent = isPickup ? "var(--secondary)" : "var(--primary)";
  const done = leg.completed;
  const typeLabel = isPickup ? "PICKUP" : "DROP";
  const incomplete = isLegIncomplete(leg);

  // Locally controlled text so typing is smooth; commit to backend on change.
  const [commodity, setCommodity] = useState(leg.commodity);
  const [scuText, setScuText] = useState(
    leg.scuTotal === 0 ? "" : String(leg.scuTotal),
  );
  const [location, setLocation] = useState(leg.location ?? "");

  // Re-sync when the underlying leg changes (e.g. a live event updated it, or a
  // different mission opened reusing this row position).
  useEffect(() => {
    setCommodity(leg.commodity);
    setScuText(leg.scuTotal === 0 ? "" : String(leg.scuTotal));
    setLocation(leg.location ?? "");
  }, [leg.missionId, leg.id, leg.commodity, leg.scuTotal, leg.location]);

  // Offer EVERY known destination (the bug fix), not just cargo centers — but
  // surface cargo centers first so the common drops are easy to reach. Free-text
  // entry still works for anything not in the list.
  const terminals = sortDestinations(reference.terminals);

  const checkbox = (
    <button
      onClick={onToggle}
      title={done ? "Mark not delivered" : "Mark delivered"}
      style={{
        width: 20,
        height: 20,
        flex: "none",
        border: `1.5px solid ${
          done ? "var(--success)" : "rgba(86,180,200,0.45)"
        }`,
        background: done ? "rgba(84,224,138,0.16)" : "transparent",
        color: done ? "var(--success)" : "transparent",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        padding: 0,
      }}
    >
      ✓
    </button>
  );

  const fieldStyle: React.CSSProperties = {
    background: "var(--window)",
    border: "1px solid rgba(86,180,200,0.25)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 12,
    padding: "7px 8px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  const commodityListId = `commodities-${leg.id}`;
  const terminalListId = `terminals-${leg.id}`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "9px 11px",
        background: incomplete
          ? "rgba(255,178,74,0.06)"
          : "rgba(86,180,200,0.04)",
        borderLeft: `2px solid ${incomplete ? "var(--secondary)" : accent}`,
        opacity: done ? 0.55 : 1,
      }}
    >
      {/* top line: checkbox + type + incomplete hint */}
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        {checkbox}
        <span
          style={{
            color: accent,
            fontWeight: 700,
            fontFamily: "var(--font-display)",
            letterSpacing: 0.5,
            fontSize: 11,
          }}
        >
          {typeLabel}
        </span>
        {incomplete && (
          <span
            title="The game log suppressed this leg's details — fill them in below."
            style={{
              marginLeft: "auto",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 9,
              letterSpacing: 1,
              color: "var(--secondary)",
              border: "1px solid rgba(255,178,74,0.4)",
              background: "rgba(255,178,74,0.1)",
              padding: "2px 7px",
            }}
          >
            ⚠ DETAILS MISSING
          </span>
        )}
        {onRemove && (
          <button
            className="sc-danger-btn"
            onClick={onRemove}
            disabled={!canRemove}
            title={
              canRemove ? "Remove leg" : "A mission needs at least one leg"
            }
            style={{
              marginLeft: incomplete ? 8 : "auto",
              width: 26,
              height: 26,
              flex: "none",
              background: "transparent",
              border: "1px solid rgba(255,107,107,0.3)",
              color: "var(--danger)",
              cursor: canRemove ? "pointer" : "not-allowed",
              opacity: canRemove ? 1 : 0.4,
              fontSize: 12,
              padding: 0,
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* edit grid: commodity / location / SCU */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 70px",
          gap: 7,
          alignItems: "center",
        }}
      >
        <input
          value={commodity}
          list={commodityListId}
          placeholder="Commodity…"
          onChange={(e) => {
            setCommodity(e.target.value);
            onEditLeg({ commodity: e.target.value });
          }}
          style={fieldStyle}
        />
        <datalist id={commodityListId}>
          {reference.commodities.map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>

        <input
          value={location}
          list={terminalListId}
          placeholder="Destination…"
          onChange={(e) => {
            const v = e.target.value;
            setLocation(v);
            onEditLeg({ location: v.trim() === "" ? null : v });
          }}
          style={fieldStyle}
        />
        <datalist id={terminalListId}>
          {terminals.map((t) => (
            <option
              key={t.name}
              value={t.displayname || t.nickname || t.name}
            />
          ))}
        </datalist>

        <input
          value={scuText}
          inputMode="numeric"
          placeholder="SCU"
          onChange={(e) => {
            const digits = e.target.value.replace(/[^0-9]/g, "");
            setScuText(digits);
            onEditLeg({ scuTotal: parseInt(digits || "0", 10) });
          }}
          style={{
            ...fieldStyle,
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            color: "var(--text-bright)",
            textAlign: "right",
          }}
        />
      </div>
    </div>
  );
}
