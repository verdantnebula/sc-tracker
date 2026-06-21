// LogStatusIndicator — design README §1. Pulsing green dot = watching Game.log.
// Reflects the three LogConnectionState values from the shared LogStatus type.
import type { LogStatus } from "@shared/types";

export function LogStatusIndicator({
  status,
  onLocate,
}: {
  status: LogStatus | null;
  /**
   * When provided AND the log is not currently connected, render a "Locate
   * Game.log" affordance so a fresh user on a non-standard install can point the
   * watcher at their LIVE folder without digging through settings.
   */
  onLocate?: () => void;
}): React.JSX.Element {
  const state = status?.state ?? "searching";
  const connected = state === "connected";
  const disconnected = state === "disconnected";
  const showLocate = !connected && onLocate !== undefined;

  const theme = connected
    ? {
        border: "rgba(84,224,138,0.28)",
        bg: "rgba(84,224,138,0.06)",
        dot: "var(--success)",
        text: "var(--success)",
        label: "LOG CONNECTED",
      }
    : disconnected
      ? {
          border: "rgba(255,107,107,0.3)",
          bg: "rgba(255,107,107,0.06)",
          dot: "var(--danger)",
          text: "var(--danger)",
          label: "LOG DISCONNECTED",
        }
      : {
          border: "var(--border-strong)",
          bg: "transparent",
          dot: "var(--muted)",
          text: "var(--muted)",
          label: "SEARCHING FOR LOG",
        };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        title={status?.logPath ?? "Game.log not located"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: `1px solid ${theme.border}`,
          background: theme.bg,
        }}
      >
        <span
          className={connected ? "sc-pulse-dot" : undefined}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: theme.dot,
            flex: "none",
          }}
        />
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 1,
            color: theme.text,
          }}
        >
          {theme.label}
        </span>
      </div>

      {showLocate && (
        <button
          className="sc-ghost-btn"
          onClick={onLocate}
          title="Point the watcher at your StarCitizen \LIVE\ folder"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 11px",
            background: "rgba(52,224,224,0.06)",
            border: "1px solid rgba(86,180,200,0.4)",
            color: "var(--primary)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 0.5,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          ⌖ Locate Game.log
        </button>
      )}
    </div>
  );
}
