// ============================================================================
// LogMissingBanner — full-width amber warning strip shown directly under the
// TopBar (above the TabBar) whenever the resolved Game.log can't be found. It is
// the first thing a user with a non-standard install (or a mis-set custom
// folder) sees, explaining why the app is empty and how to fix it.
//
// Visibility is decided by the pure `shouldShowLogBanner` predicate in selectors
// (driven by `logPathInfo.gameLogExists` / the disconnected log status), so this
// component only renders the strip — the parent owns when to mount it. The
// "Set LIVE folder…" button calls the SAME pick handler the gear panel and the
// 'Locate Game.log' affordance use (no duplicated logic). Not a modal; a banner.
// ============================================================================

import type { LogPathInfo } from "@shared/types";

export function LogMissingBanner({
  logPathInfo,
  onPickLogFolder,
}: {
  logPathInfo: LogPathInfo | null;
  /** Shared native-picker handler (same as gear panel / 'Locate Game.log'). */
  onPickLogFolder: () => void;
}): React.JSX.Element {
  const path = logPathInfo?.gameLogPath ?? null;

  return (
    <div
      role="alert"
      className="sc-log-banner"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 18px",
        // Amber/warning on a near-black surface, on-brand with the design tokens.
        background:
          "linear-gradient(180deg, rgba(255,178,74,0.12), rgba(20,14,4,0.55))",
        borderBottom: "1px solid rgba(255,178,74,0.45)",
        boxShadow: "inset 0 1px 0 rgba(255,178,74,0.25)",
      }}
    >
      {/* Warning icon */}
      <span
        aria-hidden="true"
        style={{
          flex: "none",
          fontSize: 18,
          lineHeight: 1,
          color: "var(--secondary)",
          textShadow: "0 0 10px rgba(255,178,74,0.5)",
        }}
      >
        ⚠
      </span>

      {/* Message + path it looked in */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 0.3,
            color: "var(--secondary)",
          }}
        >
          Star Citizen log not found — missions can&apos;t be tracked.
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-2)",
            marginTop: 3,
            wordBreak: "break-all",
            lineHeight: 1.4,
          }}
        >
          {path ? (
            <>
              Looked in:{" "}
              <span style={{ color: "var(--text-bright)" }}>{path}</span>
            </>
          ) : (
            "No Game.log path resolved yet."
          )}
        </div>
      </div>

      {/* Primary action — shared pick handler */}
      <button
        className="sc-primary-btn"
        onClick={onPickLogFolder}
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 15px",
          background: "var(--secondary)",
          border: "1px solid var(--secondary)",
          color: "#1c1203",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 12,
          letterSpacing: 0.8,
          cursor: "pointer",
          whiteSpace: "nowrap",
          boxShadow: "0 0 16px rgba(255,178,74,0.32)",
        }}
      >
        ⌖ Set LIVE folder…
      </button>
    </div>
  );
}
