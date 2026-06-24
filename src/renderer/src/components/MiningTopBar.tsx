// ============================================================================
// MiningTopBar — the mining shell's 58px header.
// ----------------------------------------------------------------------------
// A minimal header carrying the shared mode switcher (top-left) on the MISC
// theme, plus a short tagline on the right identifying this as a read-only
// reference. The right-hand flex slot is laid out so a later mining phase (log
// correlation, run tracking) can add domain controls without restructuring.
// Everything is token-driven so it skins to the MISC azure theme for free.
// ============================================================================

import { ModeSwitcher } from "./ModeSwitcher";

export function MiningTopBar({
  onToggleMode,
  body,
  overlayEnabled,
  onToggleOverlay,
}: {
  onToggleMode: () => void;
  /** The player's resolved current body (Hurston/…/Pyro), or null if unknown. */
  body: string | null;
  /** Whether the shared always-on-top overlay window is currently open. */
  overlayEnabled: boolean;
  /** Toggle the shared overlay window open/closed (shows the Mining panel). */
  onToggleOverlay: () => void;
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
          "linear-gradient(180deg, rgba(22,34,50,0.92), rgba(11,18,28,0.6))",
      }}
    >
      <ModeSwitcher mode="mining" onToggle={onToggleMode} />

      {/* Near-you chip — mirrors the cargo LOCATION chip. Shows the resolved
          body, or an em dash when no location maps to one. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: "1px solid rgba(86,180,200,0.22)",
          background: "rgba(52,224,224,0.06)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 10,
            color: "var(--muted)",
            letterSpacing: 1.5,
            flex: "none",
          }}
        >
          NEAR YOU
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "var(--primary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {body ?? "—"}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: 11,
          letterSpacing: 1.5,
          color: "var(--muted)",
        }}
      >
        MISC PROSPECTOR · SCAN REFERENCE
      </span>

      {/* Overlay pin toggle — opens/closes the SHARED always-on-top overlay
          window. The single overlay is shared with Cargo; its content follows
          the active mode, so in Mining it shows the SCAN ID + NEAR YOU panel.
          Same overlay:toggle IPC + state the cargo TopBar uses. */}
      <button
        className="sc-ghost-btn"
        onClick={onToggleOverlay}
        aria-label="Toggle mining overlay"
        aria-pressed={overlayEnabled}
        title={
          overlayEnabled
            ? "Hide the always-on-top mining overlay"
            : "Show an always-on-top mining overlay over the game"
        }
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 34,
          height: 34,
          background: overlayEnabled ? "rgba(52,224,224,0.10)" : "transparent",
          border: `1px solid ${
            overlayEnabled ? "var(--primary)" : "var(--border-strong)"
          }`,
          color: overlayEnabled ? "var(--primary)" : "var(--text-2)",
          fontSize: 15,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        📌
      </button>
    </header>
  );
}
