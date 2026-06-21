// ============================================================================
// ModeSwitcher — the top-left Cargo <-> Salvage toggle (shared by both shells).
// ----------------------------------------------------------------------------
// Replaces the static diamond logo + wordmark with a clickable control: it shows
// the CURRENT mode's identity ("SC CARGO TRACKER" / "SC SALVAGE TRACKER") and a
// small "⇄ SALVAGE" / "⇄ CARGO" hint for where a click goes. Clicking calls
// onToggle, which (in App) persists the new mode via window.api and re-renders.
//
// It is purely token-driven (var(--primary) etc.), so it inherits whichever
// theme is active — cyan in cargo, Drake orange in salvage — with no per-mode
// styling here. Both shells render it so the switcher is always top-left.
// ============================================================================

import type { AppMode } from "@shared/types";

export function ModeSwitcher({
  mode,
  onToggle,
}: {
  mode: AppMode;
  onToggle: () => void;
}): React.JSX.Element {
  const isCargo = mode === "cargo";
  const other = isCargo ? "SALVAGE" : "CARGO";
  return (
    <button
      className="sc-ghost-btn"
      onClick={onToggle}
      title={`Switch to ${other} mode`}
      aria-label={`Switch to ${other} tracker`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "5px 12px 5px 8px",
        background: "transparent",
        border: "1px solid var(--border-strong)",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {/* Diamond logo — tints to the active theme's primary. */}
      <div
        style={{
          width: 26,
          height: 26,
          flex: "none",
          border: "1.5px solid var(--primary)",
          transform: "rotate(45deg)",
          boxShadow: "0 0 14px var(--primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            background: "var(--primary)",
            boxShadow: "0 0 8px var(--primary)",
            display: "block",
          }}
        />
      </div>

      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 16,
          color: "var(--text-bright)",
          letterSpacing: 0.5,
        }}
      >
        SC {isCargo ? "CARGO" : "SALVAGE"}
        <span style={{ color: "var(--primary)" }}>TRACKER</span>
      </span>

      {/* switch hint chip */}
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 9,
          letterSpacing: 1.5,
          color: "var(--primary)",
          padding: "3px 7px",
          border: "1px solid var(--border)",
        }}
      >
        ⇄ {other}
      </span>
    </button>
  );
}
