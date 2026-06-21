// LegRow — design README §4 (compact) and §5 (two-line, in the detail panel).
// Pickup = amber accent, dropoff = cyan. Completed legs dim to 0.4 + strikethrough.
import type { Leg } from "@shared/types";
import { fmt } from "../lib/selectors";

export function LegRow({
  leg,
  variant,
  onToggle,
}: {
  leg: Leg;
  /** "list" = single-line mission card row; "detail" = two-line panel row. */
  variant: "list" | "detail";
  onToggle: () => void;
}): React.JSX.Element {
  const isPickup = leg.kind === "pickup";
  const accent = isPickup ? "var(--secondary)" : "var(--primary)";
  const done = leg.completed;
  const typeLabel = isPickup ? "PICKUP" : "DROP";
  const nameColor = done ? "var(--muted-done)" : "var(--text)";
  const scuColor = done ? "var(--muted-done)" : "var(--text-bright)";
  const strike = done ? "line-through" : "none";

  const checkbox = (
    <button
      onClick={onToggle}
      title={done ? "Mark not delivered" : "Mark delivered"}
      style={{
        width: 20,
        height: 20,
        flex: "none",
        border: `1.5px solid ${done ? "var(--success)" : "rgba(86,180,200,0.45)"}`,
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

  if (variant === "detail") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 11,
          padding: "9px 11px",
          background: "rgba(86,180,200,0.04)",
          borderLeft: `2px solid ${accent}`,
          opacity: done ? 0.4 : 1,
        }}
      >
        {checkbox}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            flex: 1,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: nameColor,
              fontWeight: 600,
              textDecoration: strike,
            }}
          >
            {leg.commodity}
          </span>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            <span
              style={{
                color: accent,
                fontWeight: 700,
                fontFamily: "var(--font-display)",
                letterSpacing: 0.5,
              }}
            >
              {typeLabel}
            </span>{" "}
            · {leg.location ?? "—"}
          </span>
        </div>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 15,
            color: scuColor,
            textDecoration: strike,
          }}
        >
          {fmt(leg.scuTotal)}
        </span>
      </div>
    );
  }

  // list variant (mission card)
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 11px",
        background: "rgba(86,180,200,0.04)",
        borderLeft: `2px solid ${accent}`,
        opacity: done ? 0.4 : 1,
      }}
    >
      {checkbox}
      <span
        style={{
          fontSize: 9,
          letterSpacing: 1,
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          color: accent,
          width: 46,
          flex: "none",
        }}
      >
        {typeLabel}
      </span>
      <span
        style={{
          fontSize: 13,
          color: nameColor,
          fontWeight: 500,
          textDecoration: strike,
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {leg.commodity}
      </span>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>
        {leg.location ?? "—"}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 15,
          color: scuColor,
          width: 66,
          textAlign: "right",
          textDecoration: strike,
        }}
      >
        {fmt(leg.scuTotal)}
      </span>
    </div>
  );
}
