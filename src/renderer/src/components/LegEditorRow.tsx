// LegEditorRow — design README §6. One editable leg on a 108px 1fr 1fr 78px 32px
// grid: type / commodity / location / SCU + remove. Commodity + location options
// come from UEX ReferenceData (no hardcoded lists). Locations filter to cargo
// centers. Defaults are blank/unselected.
import type { ReferenceData, ManualLegInput, LegKind } from "@shared/types";

export function LegEditorRow({
  leg,
  reference,
  canRemove,
  onChangeKind,
  onChangeCommodity,
  onChangeLocation,
  onChangeScu,
  onRemove,
}: {
  leg: ManualLegInput;
  reference: ReferenceData;
  canRemove: boolean;
  onChangeKind: (kind: LegKind) => void;
  onChangeCommodity: (commodity: string) => void;
  onChangeLocation: (location: string | null) => void;
  onChangeScu: (scu: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const fieldStyle: React.CSSProperties = {
    background: "var(--window)",
    border: "1px solid rgba(86,180,200,0.25)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 12,
    padding: "9px 8px",
    outline: "none",
    cursor: "pointer",
  };
  const typeColor =
    leg.kind === "pickup" ? "var(--secondary)" : "var(--primary)";
  const locations = reference.terminals.filter((t) => t.isCargoCenter);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "108px 1fr 1fr 78px 32px",
        gap: 8,
        alignItems: "center",
      }}
    >
      <select
        value={leg.kind}
        onChange={(e) => onChangeKind(e.target.value as LegKind)}
        style={{
          ...fieldStyle,
          color: typeColor,
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: 0.5,
        }}
      >
        <option value="pickup">PICKUP</option>
        <option value="dropoff">DROPOFF</option>
      </select>

      <select
        value={leg.commodity}
        onChange={(e) => onChangeCommodity(e.target.value)}
        style={fieldStyle}
      >
        <option value="">Select commodity…</option>
        {reference.commodities.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>

      <select
        value={leg.location ?? ""}
        onChange={(e) => onChangeLocation(e.target.value || null)}
        style={fieldStyle}
      >
        <option value="">Select location…</option>
        {locations.map((t) => (
          <option key={t.name} value={t.name}>
            {t.displayname || t.name}
          </option>
        ))}
      </select>

      <input
        value={leg.scuTotal === 0 ? "" : String(leg.scuTotal)}
        onChange={(e) =>
          onChangeScu(
            parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10),
          )
        }
        type="text"
        inputMode="numeric"
        placeholder="0"
        style={{
          ...fieldStyle,
          color: "var(--text-bright)",
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 13,
          width: "100%",
          cursor: "text",
        }}
      />

      <button
        className="sc-danger-btn"
        onClick={onRemove}
        disabled={!canRemove}
        title={canRemove ? "Remove leg" : "At least one leg is required"}
        style={{
          width: 32,
          height: 32,
          background: "transparent",
          border: "1px solid rgba(255,107,107,0.3)",
          color: "var(--danger)",
          cursor: canRemove ? "pointer" : "not-allowed",
          opacity: canRemove ? 1 : 0.4,
          fontSize: 13,
        }}
      >
        ✕
      </button>
    </div>
  );
}
