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
import { payoutFactor, partialPayout } from "@shared/payout";
import { StatusBadge } from "./StatusBadge";
import { EditableLegRow } from "./EditableLegRow";

export function MissionDetailPanel({
  mission,
  reference,
  onClose,
  onToggleLeg,
  onEditLeg,
  onSetDelivered,
  onAddLeg,
  onRemoveLeg,
  onSetPayout,
  onSetReward,
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
  /** Set a partial delivered amount on a leg (0..scuTotal). */
  onSetDelivered: (legId: string, scuDelivered: number) => void;
  onAddLeg: (kind: LegKind) => void;
  onRemoveLeg: (legId: string) => void;
  onSetPayout: (payout: number) => void;
  /** Set the full contract reward (aUEC) for the partial-payout estimate. */
  onSetReward: (reward: number | null) => void;
  onSetNotes: (notes: string) => void;
  onAbandon: () => void;
}): React.JSX.Element {
  const t = missionTotals(mission);
  const incomplete = isMissionIncomplete(mission);
  // Local controlled fields so typing is smooth; commit to backend on change.
  const [payoutText, setPayoutText] = useState<string>(
    mission.payout != null ? String(mission.payout) : "",
  );
  const [rewardText, setRewardText] = useState<string>(
    mission.reward != null ? String(mission.reward) : "",
  );
  const [notes, setNotes] = useState<string>(mission.notes);

  // Re-sync when a different mission opens.
  useEffect(() => {
    setPayoutText(mission.payout != null ? String(mission.payout) : "");
    setRewardText(mission.reward != null ? String(mission.reward) : "");
    setNotes(mission.notes);
  }, [mission.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- partial-payout estimate (see @shared/payout — APPROXIMATION) ---
  // Sum dropoff legs only (the SCU that actually pays). A completed leg counts as
  // fully delivered. Ratio drives the step-function factor; reward (if set) drives
  // the expected cash payout, both updating live as partials change.
  const drops = mission.legs.filter((l) => l.kind === "dropoff");
  const totalRequired = drops.reduce((a, l) => a + l.scuTotal, 0);
  const totalDelivered = drops.reduce(
    (a, l) => a + (l.completed ? l.scuTotal : l.scuDelivered),
    0,
  );
  const deliveredRatio = totalRequired > 0 ? totalDelivered / totalRequired : 0;
  const factor = payoutFactor(deliveredRatio);
  const reward = mission.reward;
  const expectedPayout =
    reward != null
      ? partialPayout(reward, totalDelivered, totalRequired)
      : null;
  // The next bracket to chase (for the "deliver ≥X% for Y%" hint).
  const nextBracket =
    factor >= 1
      ? null
      : factor >= 0.76
        ? { pct: 100, factorPct: 100 }
        : factor >= 0.45
          ? { pct: 75, factorPct: 76 }
          : factor >= 0.15
            ? { pct: 50, factorPct: 45 }
            : { pct: 25, factorPct: 15 };

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
                onSetDelivered={(scuDelivered) =>
                  onSetDelivered(leg.id, scuDelivered)
                }
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
              PAYOUT · aUEC (actual, logged)
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

          {/* Reward + partial-payout estimate (Phase B2). The reward is the full
              contract reward (manual); the readout shows the delivered ratio, the
              factor %, and — once a reward is set — the estimated payout for the
              current delivered SCU. The model is an APPROXIMATION (see
              @shared/payout); the ACTUAL payout above wins once logged. */}
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
              REWARD · aUEC (full contract)
            </label>
            <input
              value={rewardText}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^0-9]/g, "");
                setRewardText(digits);
                onSetReward(digits === "" ? null : parseInt(digits, 10));
              }}
              inputMode="numeric"
              placeholder="e.g. 130000"
              style={{
                background: "var(--window)",
                border: "1px solid rgba(86,180,200,0.25)",
                color: "var(--primary)",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 16,
                padding: "10px 12px",
                outline: "none",
              }}
            />

            {/* Delivered ratio + factor readout. Only meaningful when there is a
                known quantity to deliver against. */}
            {totalRequired > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  background: "rgba(52,224,224,0.04)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text-2)",
                      fontFamily: "var(--font-body)",
                    }}
                  >
                    Delivered{" "}
                    <strong style={{ color: "var(--text-bright)" }}>
                      {Math.round(deliveredRatio * 100)}%
                    </strong>{" "}
                    ({fmt(totalDelivered)}/{fmt(totalRequired)} SCU) →{" "}
                    <strong style={{ color: "var(--primary)" }}>
                      {Math.round(factor * 100)}%
                    </strong>{" "}
                    of reward
                  </span>
                </div>
                {nextBracket && (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--muted)",
                      fontFamily: "var(--font-body)",
                    }}
                  >
                    Deliver ≥{nextBracket.pct}% for {nextBracket.factorPct}% of
                    reward.
                  </span>
                )}
                {expectedPayout != null && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                      gap: 8,
                      marginTop: 2,
                      paddingTop: 6,
                      borderTop: "1px dashed rgba(86,180,200,0.18)",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        letterSpacing: 1,
                        color: "var(--muted)",
                        fontFamily: "var(--font-display)",
                        fontWeight: 600,
                      }}
                    >
                      EXPECTED PAYOUT (EST.)
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontWeight: 700,
                        fontSize: 16,
                        color: "var(--success)",
                      }}
                    >
                      {fmt(expectedPayout)} aUEC
                    </span>
                  </div>
                )}
                <span
                  style={{
                    fontSize: 9,
                    color: "var(--muted)",
                    fontFamily: "var(--font-body)",
                    fontStyle: "italic",
                    lineHeight: 1.4,
                  }}
                >
                  Estimate only — re-validate the curve per patch. The actual
                  logged payout above is authoritative once the mission
                  completes.
                </span>
              </div>
            )}
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
