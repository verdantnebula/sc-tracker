// MissionCard — design README §4. Title, giver, status, payout, progress + legs.
import type { Mission } from "@shared/types";
import {
  fmt,
  missionTotals,
  payoutDisplay,
  variantLabel,
  gradeLabel,
  isMissionIncomplete,
} from "../lib/selectors";
import { StatusBadge } from "./StatusBadge";
import { SCUProgressBar } from "./SCUProgressBar";
import { LegRow } from "./LegRow";

export function MissionCard({
  mission,
  onToggleLeg,
  onOpenDetails,
}: {
  mission: Mission;
  onToggleLeg: (legId: string, completed: boolean) => void;
  onOpenDetails: () => void;
}): React.JSX.Element {
  const t = missionTotals(mission);
  const incomplete = isMissionIncomplete(mission);
  return (
    <div
      style={{
        background:
          "linear-gradient(180deg, rgba(13,24,30,0.88), rgba(8,14,18,0.62))",
        border: "1px solid var(--border)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        clipPath:
          "polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: 16,
                color: "var(--text-bright)",
              }}
            >
              {mission.title}
            </span>
            <StatusBadge status={mission.status} />
            {incomplete && (
              <button
                onClick={onOpenDetails}
                title="The game log didn't report some leg details. Click to fill them in."
                className="sc-ghost-btn"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 9px",
                  background: "var(--status-progress-bg)",
                  border: "1px solid rgba(255,178,74,0.45)",
                  color: "var(--secondary)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: 9.5,
                  letterSpacing: 0.8,
                  cursor: "pointer",
                }}
              >
                ⚠ DETAILS MISSING — TAP TO COMPLETE
              </button>
            )}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>
              {mission.giver}
            </span>
            <span>·</span>
            <span>{variantLabel(mission.variant)}</span>
            <span>·</span>
            <span>{gradeLabel(mission.grade)}</span>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 3,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 24,
              color: "var(--primary)",
              textShadow: "0 0 12px rgba(52,224,224,0.35)",
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
      </div>

      <SCUProgressBar
        pct={t.pctDelivered}
        legCountStr={`${t.legsDone} / ${t.legsTotal}`}
      />

      {/* Legs */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {mission.legs.map((leg) => (
          <LegRow
            key={leg.id}
            leg={leg}
            variant="list"
            onToggle={() => onToggleLeg(leg.id, !leg.completed)}
          />
        ))}
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              fontSize: 10,
              letterSpacing: 1,
              color: "var(--muted)",
              fontFamily: "var(--font-display)",
            }}
          >
            PAYOUT
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 14,
              color: "var(--secondary)",
            }}
          >
            {payoutDisplay(mission.payout, mission.payoutConfidence)}
          </span>
        </div>
        <button
          className="sc-ghost-btn"
          onClick={onOpenDetails}
          style={{
            padding: "7px 14px",
            background: "transparent",
            border: "1px solid var(--border-strong)",
            color: "var(--text-2)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          DETAILS ▸
        </button>
      </div>
    </div>
  );
}
