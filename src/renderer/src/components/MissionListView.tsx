// MissionListView — design README §4. Centered vertical stack of MissionCards
// for ACTIVE missions (current session, accepted / in_progress). Terminal hauls
// and stale historical records live in History. A header offers a Manual Add
// action (relocated from the top bar — it's a mission-creation action that
// belongs on this page) and a Clear action to dismiss the whole active list.
import type { Mission } from "@shared/types";
import { MissionCard } from "./MissionCard";

export function MissionListView({
  missions,
  gap,
  onToggleLeg,
  onOpenDetails,
  onManualAdd,
  onClearActive,
}: {
  missions: Mission[];
  gap: number;
  onToggleLeg: (missionId: string, legId: string, completed: boolean) => void;
  onOpenDetails: (missionId: string) => void;
  /** Open the manual-entry form (ManualEntryForm) — relocated from the TopBar. */
  onManualAdd: () => void;
  onClearActive: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap,
        maxWidth: 940,
        margin: "0 auto",
      }}
    >
      {/* Header: active count + Clear action */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 1.5,
            color: "var(--muted)",
          }}
        >
          ACTIVE MISSIONS · {missions.length}
        </span>
        {/* Right-hand actions: Manual Add (relocated from the top bar) + Clear. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            className="sc-primary-btn"
            onClick={onManualAdd}
            title="Add a haul by hand (opens the manual-entry form)"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 13px",
              background: "var(--primary)",
              border: "1px solid var(--primary)",
              color: "#04181a",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 11,
              letterSpacing: 1,
              cursor: "pointer",
              boxShadow: "0 0 18px rgba(52,224,224,0.38)",
              whiteSpace: "nowrap",
            }}
          >
            + MANUAL ADD
          </button>
          <button
            className="sc-ghost-btn"
            onClick={onClearActive}
            disabled={missions.length === 0}
            title="Remove all active missions (History is kept)"
            style={{
              background: "transparent",
              border: "1px solid var(--status-abandoned, #c0556a)",
              color: "var(--status-abandoned, #e08a9a)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: 11,
              letterSpacing: 0.5,
              padding: "6px 12px",
              cursor: missions.length === 0 ? "not-allowed" : "pointer",
              opacity: missions.length === 0 ? 0.4 : 1,
            }}
          >
            ⌫ Clear List
          </button>
        </div>
      </div>

      {missions.length === 0 ? (
        <div
          style={{
            padding: "40px 0",
            textAlign: "center",
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
          }}
        >
          No active missions this session. Accepted hauls from the live game
          will appear here; completed ones are in History.
        </div>
      ) : (
        missions.map((m) => (
          <MissionCard
            key={m.id}
            mission={m}
            onToggleLeg={(legId, completed) =>
              onToggleLeg(m.id, legId, completed)
            }
            onOpenDetails={() => onOpenDetails(m.id)}
          />
        ))
      )}
    </div>
  );
}
