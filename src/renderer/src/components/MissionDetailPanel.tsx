// MissionDetailPanel — design README §5. Right slide-in: stat tiles, all legs
// (incl. pickup), editable payout (aUEC) + notes, abandon. Editing payout sets
// confidence -> confirmed (SPEC §10 delta 3).
import { useEffect, useState } from "react";
import type { LegKind, Mission, ReferenceData } from "@shared/types";
import {
  fmt,
  missionTotals,
  variantLabel,
  gradeLabel,
  isMissionIncomplete,
} from "../lib/selectors";
import { StatusBadge } from "./StatusBadge";
import { EditableLegRow } from "./EditableLegRow";

export function MissionDetailPanel({
  mission,
  reference,
  onClose,
  onToggleLeg,
  onEditLeg,
  onAddLeg,
  onRemoveLeg,
  onSetPayout,
  onSetNotes,
  onAbandon,
}: {
  mission: Mission;
  reference: ReferenceData;
  onClose: () => void;
  onToggleLeg: (legId: string, completed: boolean) => void;
  onEditLeg: (
    legId: string,
    patch: { commodity?: string; scuTotal?: number; location?: string | null },
  ) => void;
  onAddLeg: (kind: LegKind) => void;
  onRemoveLeg: (legId: string) => void;
  onSetPayout: (payout: number) => void;
  onSetNotes: (notes: string) => void;
  onAbandon: () => void;
}): React.JSX.Element {
  const t = missionTotals(mission);
  const incomplete = isMissionIncomplete(mission);
  // Local controlled fields so typing is smooth; commit to backend on change.
  const [payoutText, setPayoutText] = useState<string>(
    mission.payout != null ? String(mission.payout) : "",
  );
  const [notes, setNotes] = useState<string>(mission.notes);

  // Re-sync when a different mission opens.
  useEffect(() => {
    setPayoutText(mission.payout != null ? String(mission.payout) : "");
    setNotes(mission.notes);
  }, [mission.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 20,
          background: "rgba(2,5,7,0.62)",
          backdropFilter: "blur(2px)",
        }}
      />
      {/* Panel */}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 21,
          width: 444,
          maxWidth: "100%",
          background: "var(--surface)",
          borderLeft: "1px solid rgba(86,180,200,0.32)",
          boxShadow: "-22px 0 60px rgba(0,0,0,0.55)",
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
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              minWidth: 0,
            }}
          >
            <StatusBadge status={mission.status} alignStart />
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: 18,
                color: "var(--text-bright)",
                lineHeight: 1.2,
              }}
            >
              {mission.title}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>
              {mission.giver} · {variantLabel(mission.variant)} ·{" "}
              {gradeLabel(mission.grade)}
            </span>
          </div>
          <button
            className="sc-ghost-btn"
            onClick={onClose}
            style={{
              width: 30,
              height: 30,
              flex: "none",
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
            flex: 1,
            overflowY: "auto",
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {/* Stat tiles */}
          <div style={{ display: "flex", gap: 10 }}>
            <div
              style={{
                flex: 1,
                border: "1px solid var(--border)",
                background: "rgba(52,224,224,0.04)",
                padding: "11px 13px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: 22,
                  color: "var(--primary)",
                }}
              >
                {fmt(t.scuRemaining)}
              </span>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: 1,
                  color: "var(--muted)",
                  fontFamily: "var(--font-display)",
                }}
              >
                SCU REMAINING
              </span>
            </div>
            <div
              style={{
                flex: 1,
                border: "1px solid var(--border)",
                background: "rgba(86,180,200,0.04)",
                padding: "11px 13px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: 22,
                  color: "var(--text-bright)",
                }}
              >
                {t.legsDone} / {t.legsTotal}
              </span>
              <span
                style={{
                  fontSize: 10,
                  letterSpacing: 1,
                  color: "var(--muted)",
                  fontFamily: "var(--font-display)",
                }}
              >
                DROPS DONE
              </span>
            </div>
          </div>

          {/* Incomplete banner — the game log suppressed leg details. */}
          {incomplete && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 12px",
                border: "1px solid rgba(255,178,74,0.4)",
                background: "rgba(255,178,74,0.08)",
                color: "var(--secondary)",
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              <span style={{ fontSize: 15 }}>⚠</span>
              <span>
                The game log didn't report some leg details. Fill in the
                commodity, SCU and destination below so this haul shows up in
                By-Dropoff.
              </span>
            </div>
          )}

          {/* Cargo legs (all, incl. pickup) — editable to recover suppressed fields */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div
              style={{
                fontSize: 10,
                letterSpacing: 1.5,
                color: "var(--muted)",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
              }}
            >
              CARGO LEGS
            </div>
            {mission.legs.map((leg) => (
              <EditableLegRow
                key={leg.id}
                leg={leg}
                reference={reference}
                onToggle={() => onToggleLeg(leg.id, !leg.completed)}
                onEditLeg={(patch) => onEditLeg(leg.id, patch)}
                onRemove={() => onRemoveLeg(leg.id)}
                canRemove={mission.legs.length > 1}
              />
            ))}
            {/* Add legs: Multi-to-Single / Single-to-Multi hauls (and
                log-suppressed missions) need extra pickups/dropoffs. Pickup =
                amber (--secondary), Dropoff = cyan (--primary), matching the
                leg accent colors. */}
            <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
              <button
                className="sc-add-pickup-btn"
                onClick={() => onAddLeg("pickup")}
                style={{
                  flex: 1,
                  padding: "6px 11px",
                  background: "rgba(255,178,74,0.08)",
                  border: "1px solid rgba(255,178,74,0.35)",
                  color: "var(--secondary)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                  fontSize: 11,
                  letterSpacing: 1,
                  cursor: "pointer",
                }}
              >
                + ADD PICKUP
              </button>
              <button
                className="sc-add-leg-btn"
                onClick={() => onAddLeg("dropoff")}
                style={{
                  flex: 1,
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
                + ADD DROPOFF
              </button>
            </div>
          </div>

          {/* Payout */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              style={{
                fontSize: 10,
                letterSpacing: 1.5,
                color: "var(--muted)",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
              }}
            >
              PAYOUT · aUEC (manual)
            </label>
            <input
              value={payoutText}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^0-9]/g, "");
                setPayoutText(digits);
                onSetPayout(parseInt(digits || "0", 10));
              }}
              inputMode="numeric"
              style={{
                background: "var(--window)",
                border: "1px solid rgba(86,180,200,0.25)",
                color: "var(--secondary)",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 16,
                padding: "10px 12px",
                outline: "none",
              }}
            />
          </div>

          {/* Notes */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label
              style={{
                fontSize: 10,
                letterSpacing: 1.5,
                color: "var(--muted)",
                fontFamily: "var(--font-display)",
                fontWeight: 600,
              }}
            >
              NOTES
            </label>
            <textarea
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                onSetNotes(e.target.value);
              }}
              rows={3}
              placeholder="Add a note…"
              style={{
                background: "var(--window)",
                border: "1px solid rgba(86,180,200,0.25)",
                color: "var(--text)",
                fontFamily: "var(--font-body)",
                fontSize: 13,
                padding: "10px 12px",
                resize: "none",
                outline: "none",
                lineHeight: 1.5,
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{ padding: "16px 18px", borderTop: "1px solid var(--border)" }}
        >
          <button
            className="sc-danger-btn"
            onClick={onAbandon}
            style={{
              width: "100%",
              padding: 11,
              background: "transparent",
              border: "1px solid rgba(255,107,107,0.4)",
              color: "var(--danger)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: 1,
              cursor: "pointer",
            }}
          >
            ABANDON MISSION
          </button>
        </div>
      </div>
    </>
  );
}
