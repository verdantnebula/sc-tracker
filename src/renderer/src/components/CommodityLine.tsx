// CommodityLine — design README §3, now a first-class editing surface. The
// summary row is unchanged (commodity + summed remaining SCU + click-to-deliver),
// but it now expands into one inline-editable row PER underlying leg. A single
// commodity line can aggregate several legs across missions (legRefs), so the
// expander resolves each ref to its live {mission, leg} and renders an inline
// DestinationPicker + commodity + SCU edit, each committing immediately via
// onEditLeg, plus an "EDIT MISSION ▸" button that opens the full detail panel.
//
// The check-off behavior + showDelivered are unchanged: clicking the summary
// (outside the expander/expanded rows) still toggles delivery via onCheckOff.
import { useEffect, useState } from "react";
import type { LegRef, Mission, ReferenceData } from "@shared/types";
import { fmt } from "../lib/selectors";
import { DestinationPicker } from "./DestinationPicker";

export function CommodityLine({
  commodity,
  scuRemaining,
  legRefs,
  missionsById,
  reference,
  onCheckOff,
  onEditLeg,
  onSetDelivered,
  onOpenMission,
  needsLocation = false,
  defaultExpanded = false,
}: {
  commodity: string;
  scuRemaining: number;
  /** Every leg feeding this aggregated line (across missions). */
  legRefs: LegRef[];
  /** Live missions keyed by id, for resolving a LegRef -> {mission, leg}. */
  missionsById: Map<string, Mission>;
  reference: ReferenceData;
  onCheckOff: () => void;
  /** Commit an inline edit to a specific leg. */
  onEditLeg: (
    missionId: string,
    legId: string,
    patch: { commodity?: string; scuTotal?: number; location?: string | null },
  ) => void;
  /** Set a partial delivered amount (0..scuTotal) on a specific leg. */
  onSetDelivered: (
    missionId: string,
    legId: string,
    scuDelivered: number,
  ) => void;
  /** Open the full MissionDetailPanel for a mission. */
  onOpenMission: (missionId: string) => void;
  /** When true this is the "needs a destination" bucket (amber, auto-expanded). */
  needsLocation?: boolean;
  /** Start expanded (used for the needs-location group). */
  defaultExpanded?: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const accent = needsLocation ? "var(--secondary)" : "var(--primary)";
  const bg = needsLocation ? "rgba(255,178,74,0.06)" : "rgba(52,224,224,0.05)";
  const border = needsLocation
    ? "1px solid rgba(255,178,74,0.4)"
    : "1px solid rgba(86,180,200,0.14)";

  // Resolve each leg ref to its live mission + leg (single source of truth).
  const rows = legRefs
    .map((ref) => {
      const mission = missionsById.get(ref.missionId);
      const leg = mission?.legs.find((l) => l.id === ref.legId);
      return mission && leg ? { mission, leg } : null;
    })
    .filter(
      (r): r is { mission: Mission; leg: Mission["legs"][number] } =>
        r !== null,
    );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Summary row — preserves the original click-to-deliver behavior. */}
      <div
        className="sc-commodity-line"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 10px",
          background: bg,
          border,
          borderBottom: expanded ? "none" : border,
        }}
      >
        {/* Expander toggle — a real button for a11y. */}
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse legs" : "Expand legs"}
          aria-expanded={expanded}
          title={expanded ? "Hide legs" : "Edit legs"}
          style={{
            width: 18,
            height: 18,
            flex: "none",
            background: "transparent",
            border: "none",
            color: "var(--muted)",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform .15s ease",
          }}
        >
          ▸
        </button>

        {/* The deliver hit-area: commodity + checkbox glyph (click = check off). */}
        <div
          role="button"
          onClick={onCheckOff}
          title={`Mark ${commodity} delivered here`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            minWidth: 0,
            flex: 1,
            cursor: "pointer",
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              flex: "none",
              border: `1.5px solid ${
                needsLocation ? "rgba(255,178,74,0.6)" : "rgba(86,180,200,0.5)"
              }`,
              display: "inline-block",
            }}
          />
          <span
            style={{
              fontSize: 13,
              color: "var(--text)",
              fontWeight: 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {commodity || "(unknown)"}
          </span>
        </div>

        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 16,
            color: "var(--text-bright)",
            flex: "none",
          }}
        >
          {fmt(scuRemaining)}
        </span>
      </div>

      {/* Expanded: one inline-editable row per underlying leg. */}
      {expanded && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "8px 10px 10px",
            border,
            borderTop: "none",
            background: needsLocation
              ? "rgba(255,178,74,0.03)"
              : "rgba(52,224,224,0.02)",
          }}
        >
          {rows.length === 0 && (
            <span
              style={{
                fontSize: 11,
                color: "var(--muted)",
                fontFamily: "var(--font-body)",
              }}
            >
              No matching legs.
            </span>
          )}
          {rows.map(({ mission, leg }) => (
            <LegEditRow
              key={`${mission.id}:${leg.id}`}
              missionTitle={mission.title}
              legKind={leg.kind}
              commodity={leg.commodity}
              scuTotal={leg.scuTotal}
              scuDelivered={leg.scuDelivered}
              completed={leg.completed}
              location={leg.location ?? ""}
              reference={reference}
              accent={accent}
              autoFocusDestination={needsLocation}
              onEditLeg={(patch) => onEditLeg(mission.id, leg.id, patch)}
              onSetDelivered={(scuDelivered) =>
                onSetDelivered(mission.id, leg.id, scuDelivered)
              }
              onOpenMission={() => onOpenMission(mission.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One leg's inline quick-edit: destination / commodity / SCU + "EDIT MISSION".
// Mirrors EditableLegRow's commit-on-change semantics but in the compact
// By-Dropoff context (no completion checkbox — delivery is the summary row's job).
function LegEditRow({
  missionTitle,
  legKind,
  commodity,
  scuTotal,
  scuDelivered,
  completed,
  location,
  reference,
  accent,
  autoFocusDestination,
  onEditLeg,
  onSetDelivered,
  onOpenMission,
}: {
  missionTitle: string;
  legKind: "pickup" | "dropoff";
  commodity: string;
  scuTotal: number;
  scuDelivered: number;
  completed: boolean;
  location: string;
  reference: ReferenceData;
  accent: string;
  autoFocusDestination: boolean;
  onEditLeg: (patch: {
    commodity?: string;
    scuTotal?: number;
    location?: string | null;
  }) => void;
  onSetDelivered: (scuDelivered: number) => void;
  onOpenMission: () => void;
}): React.JSX.Element {
  // Locally controlled text so typing is smooth; commit on change. Keyed by the
  // resolved leg fields below so a live update re-syncs the inputs.
  const [commodityText, setCommodityText] = useState(commodity);
  const [scuText, setScuText] = useState(
    scuTotal === 0 ? "" : String(scuTotal),
  );
  const [deliveredText, setDeliveredText] = useState(String(scuDelivered));

  // Re-sync when the underlying leg changes (e.g. a live event updated it).
  useEffect(() => {
    setCommodityText(commodity);
    setScuText(scuTotal === 0 ? "" : String(scuTotal));
    setDeliveredText(String(scuDelivered));
  }, [commodity, scuTotal, scuDelivered, completed]);

  const partial =
    !completed && scuTotal > 0 && scuDelivered > 0 && scuDelivered < scuTotal;
  const commitDelivered = (raw: number): void => {
    const clamped = Math.max(0, Math.min(scuTotal, Math.round(raw) || 0));
    setDeliveredText(String(clamped));
    onSetDelivered(clamped);
  };

  const commodityListId = `bd-commodities-${missionTitle}-${legKind}`;

  const fieldStyle: React.CSSProperties = {
    background: "var(--window)",
    border: "1px solid rgba(86,180,200,0.25)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 12,
    padding: "6px 8px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "7px 9px",
        background: "rgba(86,180,200,0.04)",
        borderLeft: `2px solid ${accent}`,
      }}
    >
      {/* leg header: mission title + leg kind + edit-mission button */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: accent,
            fontWeight: 700,
            fontFamily: "var(--font-display)",
            letterSpacing: 0.5,
            fontSize: 10,
            flex: "none",
          }}
        >
          {legKind === "pickup" ? "PICKUP" : "DROP"}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-2)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
            minWidth: 0,
          }}
          title={missionTitle}
        >
          {missionTitle}
        </span>
        <button
          className="sc-ghost-btn"
          onClick={onOpenMission}
          title="Open the full mission editor"
          style={{
            flex: "none",
            padding: "3px 9px",
            background: "transparent",
            border: "1px solid var(--border-strong)",
            color: "var(--text-2)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 9,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          EDIT MISSION ▸
        </button>
      </div>

      {/* edit grid: commodity / destination / SCU */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 64px",
          gap: 6,
          alignItems: "center",
        }}
      >
        <input
          value={commodityText}
          list={commodityListId}
          placeholder="Commodity…"
          aria-label="Commodity"
          onChange={(e) => {
            setCommodityText(e.target.value);
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
          autoFocus={autoFocusDestination}
          style={{ padding: "6px 8px" }}
          onChange={(v) => onEditLeg({ location: v.trim() === "" ? null : v })}
        />

        <input
          value={scuText}
          inputMode="numeric"
          placeholder="SCU"
          aria-label="SCU total"
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

      {/* Partial turn-in (Phase B1): a compact delivered stepper for dropoff legs
          with a known quantity. The summary row's click is the all-or-nothing
          deliver; this records a partial (e.g. 60/100) without flipping
          `completed`. Hidden when the quantity is unknown (no scale to fill). */}
      {legKind === "dropoff" && scuTotal > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
            onClick={() => commitDelivered(scuDelivered - 1)}
            disabled={scuDelivered <= 0}
            aria-label="Decrease delivered SCU"
            style={{
              width: 22,
              height: 22,
              flex: "none",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-2)",
              cursor: scuDelivered <= 0 ? "not-allowed" : "pointer",
              opacity: scuDelivered <= 0 ? 0.4 : 1,
              fontSize: 13,
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
            onChange={(e) =>
              setDeliveredText(e.target.value.replace(/[^0-9]/g, ""))
            }
            onBlur={() => commitDelivered(parseInt(deliveredText || "0", 10))}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                commitDelivered(parseInt(deliveredText || "0", 10));
            }}
            style={{
              width: 46,
              flex: "none",
              background: "var(--window)",
              border: "1px solid rgba(86,180,200,0.25)",
              color: partial ? "var(--success)" : "var(--text-bright)",
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 12,
              padding: "4px 5px",
              outline: "none",
              textAlign: "right",
            }}
          />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
              flex: "none",
            }}
          >
            / {scuTotal}
          </span>
          <button
            onClick={() => commitDelivered(scuDelivered + 1)}
            disabled={scuDelivered >= scuTotal}
            aria-label="Increase delivered SCU"
            style={{
              width: 22,
              height: 22,
              flex: "none",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-2)",
              cursor: scuDelivered >= scuTotal ? "not-allowed" : "pointer",
              opacity: scuDelivered >= scuTotal ? 0.4 : 1,
              fontSize: 13,
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
                fontSize: 10,
                color: "var(--success)",
                fontWeight: 700,
                flex: "none",
              }}
            >
              {scuDelivered}/{scuTotal}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
