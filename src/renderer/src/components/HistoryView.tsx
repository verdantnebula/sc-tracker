// HistoryView — NEW (SPEC §10 delta 1, not in prototype). Lists terminal hauls
// (completed + abandoned) newest-first in the same visual language as MissionCard
// (compact rows). Header readout = lifetime totals (label "approx · log-reported").
import type { Mission } from "@shared/types";
import {
  fmt,
  isTerminal,
  lifetimeTotals,
  missionTotals,
  payoutDisplay,
  variantLabel,
  gradeLabel,
} from "../lib/selectors";
import { StatusBadge } from "./StatusBadge";

function commoditySummary(m: Mission): string {
  const drops = m.legs.filter((l) => l.kind === "dropoff");
  const names = Array.from(new Set(drops.map((l) => l.commodity)));
  if (names.length === 0) return "—";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function formatDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function HistoryRow({
  mission,
  onOpen,
}: {
  mission: Mission;
  onOpen: () => void;
}): React.JSX.Element {
  const t = missionTotals(mission);
  const scuHauled = mission.legs
    .filter((l) => l.kind === "dropoff")
    .reduce((a, l) => a + l.scuTotal, 0);
  const isAbandoned = mission.status === "abandoned";
  return (
    <div
      onClick={onOpen}
      className="sc-history-row"
      style={{
        background:
          "linear-gradient(180deg, rgba(13,24,30,0.7), rgba(8,14,18,0.5))",
        border: "1px solid var(--border)",
        padding: "11px 14px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        cursor: "pointer",
        clipPath:
          "polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%)",
        opacity: isAbandoned ? 0.62 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          flex: 1,
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
              fontSize: 14,
              color: "var(--text-bright)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {mission.title}
          </span>
          <StatusBadge status={mission.status} />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          <span style={{ color: "var(--text-2)", fontWeight: 600 }}>
            {mission.giver}
          </span>
          <span>·</span>
          <span>{commoditySummary(mission)}</span>
          <span>·</span>
          <span>
            {variantLabel(mission.variant)} / {gradeLabel(mission.grade)}
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
          flex: "none",
        }}
      >
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
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {fmt(scuHauled)} SCU · {t.legsDone}/{t.legsTotal}
        </span>
      </div>

      <div style={{ flex: "none", textAlign: "right", minWidth: 96 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {formatDate(mission.completedAt ?? mission.acceptedAt)}
        </span>
      </div>
    </div>
  );
}

export function HistoryView({
  missions,
  onOpenMission,
}: {
  missions: Mission[];
  onOpenMission: (id: string) => void;
}): React.JSX.Element {
  const history = missions
    .filter(isTerminal)
    .sort(
      (a, b) =>
        (b.completedAt ?? b.acceptedAt ?? 0) -
        (a.completedAt ?? a.acceptedAt ?? 0),
    );
  const totals = lifetimeTotals(missions);

  const stat = (value: string, label: string): React.JSX.Element => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 22,
          color: "var(--primary)",
          textShadow: "0 0 12px rgba(52,224,224,0.3)",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 10,
          letterSpacing: 1,
          color: "var(--muted)",
          fontFamily: "var(--font-display)",
        }}
      >
        {label}
      </span>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 940,
        margin: "0 auto",
      }}
    >
      {/* Header: section title + lifetime totals */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 2,
            color: "var(--text-2)",
          }}
        >
          HAUL HISTORY
        </div>
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              "linear-gradient(90deg, rgba(86,180,200,0.3), transparent)",
          }}
        />
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted)",
            letterSpacing: 0.5,
          }}
        >
          approx · log-reported
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 28,
          padding: "16px 20px",
          border: "1px solid var(--border)",
          background: "rgba(52,224,224,0.04)",
          clipPath: "var(--notch)",
        }}
      >
        {stat(fmt(totals.missionsCompleted), "MISSIONS COMPLETED")}
        {stat(fmt(totals.scuHauled), "TOTAL SCU HAULED")}
        {stat(`${fmt(totals.creditsEarned)} aUEC`, "TOTAL CREDITS EARNED")}
      </div>

      {/* Rows */}
      {history.length === 0 ? (
        <div
          style={{
            padding: "40px 20px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 13,
            border: "1px dashed var(--border)",
          }}
        >
          No completed or abandoned hauls yet. Finished contracts and the
          backfill scan will appear here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {history.map((m) => (
            <HistoryRow
              key={m.id}
              mission={m}
              onOpen={() => onOpenMission(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
