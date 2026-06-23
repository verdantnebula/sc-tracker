// EditableLegRow — detail-panel leg row with inline editing for token-suppressed
// fields (the intermittent objectiveDeclared bug leaves commodity/scuTotal/
// location blank). Combines the completion checkbox (as in LegRow) with editable
// commodity (datalist autocomplete over UEX commodities), SCU (number), and
// location (datalist over ALL UEX destinations + free text). Edits commit on
// change via onEditLeg; the store stamps manual_override so historical replay
// can't clobber them.
import { useEffect, useState } from "react";
import type { Leg, ReferenceData } from "@shared/types";
import { isLegIncomplete } from "../lib/selectors";
import { DestinationPicker } from "./DestinationPicker";

export function EditableLegRow({
  leg,
  reference,
  onToggle,
  onEditLeg,
  onSetDelivered,
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
  /**
   * Set a PARTIAL delivered amount (0..scuTotal). Clamped by the caller's store
   * patch; the row itself clamps the input too. Unlike onToggle this never flips
   * `completed` — a value strictly between 0 and total is the partial state.
   */
  onSetDelivered: (scuDelivered: number) => void;
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
  // Partial = some (but not all) of a known quantity delivered, not yet checked.
  const partial =
    !done &&
    leg.scuTotal > 0 &&
    leg.scuDelivered > 0 &&
    leg.scuDelivered < leg.scuTotal;

  // Locally controlled text so typing is smooth; commit to backend on change.
  const [commodity, setCommodity] = useState(leg.commodity);
  const [scuText, setScuText] = useState(
    leg.scuTotal === 0 ? "" : String(leg.scuTotal),
  );
  const [location, setLocation] = useState(leg.location ?? "");
  // Delivered SCU shown as `delivered/total`; editable for partial turn-in.
  const [deliveredText, setDeliveredText] = useState(String(leg.scuDelivered));

  // Re-sync when the underlying leg changes (e.g. a live event updated it, or a
  // different mission opened reusing this row position).
  useEffect(() => {
    setCommodity(leg.commodity);
    setScuText(leg.scuTotal === 0 ? "" : String(leg.scuTotal));
    setLocation(leg.location ?? "");
    setDeliveredText(String(leg.scuDelivered));
  }, [
    leg.missionId,
    leg.id,
    leg.commodity,
    leg.scuTotal,
    leg.location,
    leg.scuDelivered,
    leg.completed,
  ]);

  // Clamp a delivered entry to 0..scuTotal and commit it.
  const commitDelivered = (raw: number): void => {
    const clamped = Math.max(0, Math.min(leg.scuTotal, Math.round(raw) || 0));
    setDeliveredText(String(clamped));
    onSetDelivered(clamped);
  };

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

  // Delivered fraction 0..1 for the partial-fill bar (only meaningful for a
  // known-quantity dropoff that isn't complete).
  const deliveredPct =
    leg.scuTotal > 0
      ? Math.min(100, Math.round((leg.scuDelivered / leg.scuTotal) * 100))
      : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "9px 11px",
        background: incomplete
          ? "rgba(255,178,74,0.06)"
          : partial
            ? "rgba(84,224,138,0.06)"
            : "rgba(86,180,200,0.04)",
        borderLeft: `2px solid ${
          incomplete ? "var(--secondary)" : partial ? "var(--success)" : accent
        }`,
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

        <DestinationPicker
          value={location}
          terminals={reference.terminals}
          ariaLabel="Destination"
          onChange={(v) => {
            setLocation(v);
            onEditLeg({ location: v.trim() === "" ? null : v });
          }}
        />

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

      {/* Partial turn-in: delivered-so-far stepper (dropoff legs with a known
          quantity). The checkbox above is the all-or-nothing path; this lets the
          user record a partial delivery (e.g. 60 / 100). Editing this never flips
          `completed` — a value strictly between 0 and total is the partial state.
          Hidden when the quantity is unknown (scuTotal 0) — there is no scale to
          deliver against; the user fills SCU first. */}
      {leg.scuTotal > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 9,
                letterSpacing: 1,
                color: "var(--muted)",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                flex: "none",
              }}
            >
              DELIVERED
            </span>
            <button
              onClick={() => commitDelivered(leg.scuDelivered - 1)}
              disabled={leg.scuDelivered <= 0}
              aria-label="Decrease delivered SCU"
              title="Deliver one less"
              style={{
                width: 24,
                height: 24,
                flex: "none",
                background: "transparent",
                border: "1px solid var(--border-strong)",
                color: "var(--text-2)",
                cursor: leg.scuDelivered <= 0 ? "not-allowed" : "pointer",
                opacity: leg.scuDelivered <= 0 ? 0.4 : 1,
                fontSize: 14,
                padding: 0,
                lineHeight: 1,
              }}
            >
              −
            </button>
            <input
              value={deliveredText}
              inputMode="numeric"
              aria-label="Delivered SCU"
              onChange={(e) => {
                const digits = e.target.value.replace(/[^0-9]/g, "");
                setDeliveredText(digits);
              }}
              onBlur={() => commitDelivered(parseInt(deliveredText || "0", 10))}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  commitDelivered(parseInt(deliveredText || "0", 10));
              }}
              style={{
                width: 52,
                flex: "none",
                background: "var(--window)",
                border: "1px solid rgba(86,180,200,0.25)",
                color: partial ? "var(--success)" : "var(--text-bright)",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 13,
                padding: "5px 6px",
                outline: "none",
                textAlign: "right",
              }}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--muted)",
                flex: "none",
              }}
            >
              / {leg.scuTotal}
            </span>
            <button
              onClick={() => commitDelivered(leg.scuDelivered + 1)}
              disabled={leg.scuDelivered >= leg.scuTotal}
              aria-label="Increase delivered SCU"
              title="Deliver one more"
              style={{
                width: 24,
                height: 24,
                flex: "none",
                background: "transparent",
                border: "1px solid var(--border-strong)",
                color: "var(--text-2)",
                cursor:
                  leg.scuDelivered >= leg.scuTotal ? "not-allowed" : "pointer",
                opacity: leg.scuDelivered >= leg.scuTotal ? 0.4 : 1,
                fontSize: 14,
                padding: 0,
                lineHeight: 1,
              }}
            >
              +
            </button>
            {partial && (
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--success)",
                  fontWeight: 700,
                  flex: "none",
                }}
              >
                {leg.scuDelivered}/{leg.scuTotal}
              </span>
            )}
          </div>
          {/* partial-fill indicator */}
          <div
            style={{
              height: 3,
              background: "rgba(86,180,200,0.12)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${deliveredPct}%`,
                background: "var(--success)",
                transition: "width .2s ease",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
