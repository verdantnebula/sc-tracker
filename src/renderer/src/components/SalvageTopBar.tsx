// ============================================================================
// SalvageTopBar — the salvage shell's 58px header.
// ----------------------------------------------------------------------------
// PHASE-1: a minimal header carrying ONLY the shared Cargo<->Salvage switcher
// (top-left) on the Drake theme. It deliberately omits cargo's domain actions
// (re-sync / manual add / reset / LIVE-folder), which are cargo concerns. Later
// salvage phases add salvage-appropriate controls into the right-hand flex slot
// that is already laid out here.
// ============================================================================

import { ModeSwitcher } from "./ModeSwitcher";

export function SalvageTopBar({
  onToggleMode,
  onCollectLogs,
}: {
  onToggleMode: () => void;
  /** Open the "Collect Logs" / Report a Problem dialog. */
  onCollectLogs: () => void;
}): React.JSX.Element {
  return (
    <header
      style={{
        height: 58,
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 18px",
        borderBottom: "1px solid var(--border)",
        background:
          "linear-gradient(180deg, rgba(40,30,21,0.92), rgba(20,15,10,0.6))",
      }}
    >
      <ModeSwitcher mode="salvage" onToggle={onToggleMode} />

      <div style={{ flex: 1 }} />

      {/* Report a Problem ("Collect Logs") — token-driven so it skins to Drake. */}
      <button
        className="sc-ghost-btn"
        onClick={onCollectLogs}
        title="Report a problem (collect logs)"
        aria-label="Report a problem (collect logs)"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 13px",
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
        🛟 COLLECT LOGS
      </button>
    </header>
  );
}
