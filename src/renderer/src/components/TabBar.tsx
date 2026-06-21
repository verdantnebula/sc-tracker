// TabBar — design README §2 + SPEC §10 delta 1 (adds HISTORY tab). Three tabs
// with count badges + the TOTAL REMAINING readout.
import { fmt } from "../lib/selectors";

export type TabKey = "dropoff" | "route" | "missions" | "history";

const TABS: { key: TabKey; label: string }[] = [
  { key: "dropoff", label: "BY-DROPOFF" },
  { key: "route", label: "ROUTE" },
  { key: "missions", label: "MISSION LIST" },
  { key: "history", label: "HISTORY" },
];

export function TabBar({
  active,
  counts,
  totalRemaining,
  onChange,
}: {
  active: TabKey;
  counts: Record<TabKey, number>;
  totalRemaining: number;
  onChange: (tab: TabKey) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        height: 50,
        flex: "none",
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--border)",
        background: "rgba(7,12,16,0.5)",
      }}
    >
      {TABS.map((t) => {
        const isActive = active === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 24px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 14,
              letterSpacing: 1,
              color: isActive ? "var(--text-bright)" : "var(--muted)",
            }}
          >
            {t.label}
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                padding: "2px 6px",
                background: "rgba(52,224,224,0.12)",
                color: "var(--primary)",
              }}
            >
              {counts[t.key]}
            </span>
            <span
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: -1,
                height: 2,
                background: isActive ? "var(--primary)" : "transparent",
                boxShadow: isActive ? "0 0 10px var(--primary)" : "none",
              }}
            />
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 22px",
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: 1.5,
            color: "var(--muted)",
            fontFamily: "var(--font-display)",
          }}
        >
          TOTAL REMAINING
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 18,
            color: "var(--primary)",
            textShadow: "0 0 12px rgba(52,224,224,0.4)",
          }}
        >
          {fmt(totalRemaining)}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--muted)",
            fontFamily: "var(--font-display)",
          }}
        >
          SCU
        </span>
      </div>
    </div>
  );
}
