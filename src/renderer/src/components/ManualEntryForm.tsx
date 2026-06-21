// ManualEntryForm — design README §6 + SPEC §10. Title/giver/status + repeatable
// LegEditorRows. Dropdowns are sourced from UEX ReferenceData (ref:get) — NO
// hardcoded commodity/location lists. Default legs start blank/unselected.
// Save enabled only with a non-empty title.
import { useState } from "react";
import type {
  ReferenceData,
  ManualMissionInput,
  ManualLegInput,
  MissionStatus,
  LegKind,
} from "@shared/types";
import { LegEditorRow } from "./LegEditorRow";

const STATUS_OPTIONS: { value: MissionStatus; label: string }[] = [
  { value: "accepted", label: "Accepted" },
  { value: "in_progress", label: "In Progress" },
  { value: "complete", label: "Complete" },
  { value: "abandoned", label: "Abandoned" },
];

function blankLeg(): ManualLegInput {
  return { kind: "dropoff", commodity: "", location: null, scuTotal: 0 };
}

export function ManualEntryForm({
  reference,
  knownGivers,
  onCancel,
  onSave,
}: {
  reference: ReferenceData;
  /** Givers discovered from logs (no guessed hardcoded list). May be empty. */
  knownGivers: string[];
  onCancel: () => void;
  onSave: (input: ManualMissionInput) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [giver, setGiver] = useState(knownGivers[0] ?? "");
  const [status, setStatus] = useState<MissionStatus>("accepted");
  const [legs, setLegs] = useState<ManualLegInput[]>([blankLeg()]);

  const canSave = title.trim().length > 0;

  const setLeg = (i: number, patch: Partial<ManualLegInput>): void =>
    setLegs((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLeg = (): void => setLegs((ls) => [...ls, blankLeg()]);
  const removeLeg = (i: number): void =>
    setLegs((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: 1.5,
    color: "var(--muted)",
    fontFamily: "var(--font-display)",
    fontWeight: 600,
  };
  const fieldStyle: React.CSSProperties = {
    background: "var(--window)",
    border: "1px solid rgba(86,180,200,0.25)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 13,
    padding: "10px 12px",
    outline: "none",
  };

  const save = (): void => {
    if (!canSave) return;
    onSave({ title: title.trim(), giver, status, legs });
  };

  return (
    <div
      onClick={onCancel}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        background: "rgba(2,5,7,0.72)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 700,
          maxWidth: "100%",
          maxHeight: "90%",
          overflowY: "auto",
          background: "var(--surface)",
          border: "1px solid rgba(86,180,200,0.32)",
          boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: 18,
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 17,
              color: "var(--text-bright)",
            }}
          >
            ＋ Add Cargo Mission
          </span>
          <button
            className="sc-ghost-btn"
            onClick={onCancel}
            style={{
              width: 30,
              height: 30,
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-2)",
              cursor: "pointer",
              fontSize: 15,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div
              style={{
                gridColumn: "1 / 3",
                display: "flex",
                flexDirection: "column",
                gap: 5,
              }}
            >
              <label style={labelStyle}>MISSION TITLE</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Senior Rank – Bulk Cargo Haul"
                style={{
                  ...fieldStyle,
                  color: "var(--text-bright)",
                  fontSize: 14,
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={labelStyle}>COMPANY</label>
              <select
                value={giver}
                onChange={(e) => setGiver(e.target.value)}
                style={{ ...fieldStyle, cursor: "pointer" }}
              >
                {knownGivers.length === 0 && (
                  <option value="">(none discovered yet)</option>
                )}
                {knownGivers.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <label style={labelStyle}>STATUS</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as MissionStatus)}
                style={{ ...fieldStyle, cursor: "pointer" }}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Legs editor */}
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <label style={labelStyle}>CARGO LEGS</label>
              <button
                className="sc-add-leg-btn"
                onClick={addLeg}
                style={{
                  padding: "6px 11px",
                  background: "rgba(52,224,224,0.08)",
                  border: "1px solid rgba(52,224,224,0.35)",
                  color: "var(--primary)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                  fontSize: 11,
                  letterSpacing: 1,
                  cursor: "pointer",
                }}
              >
                + ADD LEG
              </button>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "108px 1fr 1fr 78px 32px",
                gap: 8,
                alignItems: "center",
                fontSize: 9,
                letterSpacing: 1,
                color: "#50656f",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
                padding: "0 2px",
              }}
            >
              <span>TYPE</span>
              <span>COMMODITY</span>
              <span>LOCATION</span>
              <span>SCU</span>
              <span />
            </div>
            {legs.map((leg, i) => (
              <LegEditorRow
                key={i}
                leg={leg}
                reference={reference}
                canRemove={legs.length > 1}
                onChangeKind={(kind: LegKind) => setLeg(i, { kind })}
                onChangeCommodity={(commodity) => setLeg(i, { commodity })}
                onChangeLocation={(location) => setLeg(i, { location })}
                onChangeScu={(scuTotal) => setLeg(i, { scuTotal })}
                onRemove={() => removeLeg(i)}
              />
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 18px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <button
            className="sc-ghost-btn"
            onClick={onCancel}
            style={{
              padding: "10px 20px",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-2)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: 1,
              cursor: "pointer",
            }}
          >
            CANCEL
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            style={{
              padding: "10px 22px",
              background: "var(--primary)",
              border: "none",
              color: "#04181a",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 1,
              boxShadow: "0 0 18px rgba(52,224,224,0.35)",
              opacity: canSave ? 1 : 0.45,
              cursor: canSave ? "pointer" : "not-allowed",
            }}
          >
            SAVE MISSION
          </button>
        </div>
      </div>
    </div>
  );
}
