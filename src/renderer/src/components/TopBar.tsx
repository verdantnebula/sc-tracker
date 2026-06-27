// TopBar — design README §1. App identity + location chip + LogStatusIndicator
// + overlay pin + Settings gear. 58px fixed row. Re-sync and Reset Data live
// inside the gear popover (SettingsGear/LogFolderPanel) to keep the header lean.
// Manual Add now lives on the Mission List view (it's a mission-creation action),
// not the global top bar. The LOCATION chip and the gear are shared components
// (LocationChip / SettingsGear) reused by the Salvage + Mining bars too.
import type { LogStatus, LogPathInfo } from "@shared/types";
import { LogStatusIndicator } from "./LogStatusIndicator";
import { ModeSwitcher } from "./ModeSwitcher";
import { LocationChip } from "./LocationChip";
import { SettingsGear } from "./SettingsGear";

export function TopBar({
  logStatus,
  logPathInfo,
  currentLocation,
  onResync,
  onReset,
  onPickLogFolder,
  onCollectLogs,
  onToggleMode,
  overlayEnabled,
  onToggleOverlay,
  ocrEnabled,
  onToggleOcr,
  onOcrCapture,
  autoOcrCapture,
  onToggleAutoOcr,
}: {
  logStatus: LogStatus | null;
  logPathInfo: LogPathInfo | null;
  currentLocation: string | null;
  onResync: () => void;
  onReset: () => void;
  /** Open the native folder picker to choose a custom LIVE folder. */
  onPickLogFolder: () => void;
  /** Open the "Collect Logs" / Report a Problem dialog. */
  onCollectLogs: () => void;
  /** Switch to salvage mode (the top-left Cargo<->Salvage switcher). */
  onToggleMode: () => void;
  /** Whether the always-on-top "next stop" overlay window is currently open. */
  overlayEnabled: boolean;
  /** Toggle the overlay window open/closed (Phase D). */
  onToggleOverlay: () => void;
  /** Whether the EXPERIMENTAL OCR contract-capture feature is enabled (Phase F). */
  ocrEnabled: boolean;
  /** Toggle the experimental OCR feature on/off (persists). */
  onToggleOcr: () => void;
  /** Open the OCR capture/review dialog (only shown when ocrEnabled). */
  onOcrCapture: () => void;
  /** Whether EXPERIMENTAL Auto OCR Capture is enabled (Phase 3). */
  autoOcrCapture: boolean;
  /** Toggle Auto OCR Capture on/off (persists; gated on ocrEnabled). */
  onToggleAutoOcr: () => void;
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
          "linear-gradient(180deg, rgba(12,22,28,0.92), rgba(7,12,16,0.6))",
      }}
    >
      {/* Top-left Cargo<->Salvage switcher (replaces the static diamond+wordmark) */}
      <ModeSwitcher mode="cargo" onToggle={onToggleMode} />

      {/* Location chip — shared component (reused on the Salvage bar). */}
      <LocationChip currentLocation={currentLocation} />

      <div style={{ flex: 1 }} />

      <LogStatusIndicator status={logStatus} onLocate={onPickLogFolder} />

      {/* Overlay pin toggle (Phase D) — opens/closes the always-on-top
          "next stop" overlay window that floats over the game. Cargo mode only
          (this whole TopBar is the cargo header). Highlights when pinned. */}
      <button
        className="sc-ghost-btn"
        onClick={onToggleOverlay}
        aria-label="Toggle next-stop overlay"
        aria-pressed={overlayEnabled}
        title={
          overlayEnabled
            ? "Hide the always-on-top next-stop overlay"
            : "Show an always-on-top next-stop overlay over the game"
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

      {/* Settings (gear) — shared component (reused on Salvage + Mining bars).
          Houses the LIVE folder picker, Re-sync, Reset Data, Collect Logs, and
          the EXPERIMENTAL OCR toggle (cargo only). */}
      <SettingsGear
        logPathInfo={logPathInfo}
        onPickLogFolder={onPickLogFolder}
        onResync={onResync}
        onReset={onReset}
        onCollectLogs={onCollectLogs}
        ocr={{ ocrEnabled, onToggleOcr, autoOcrCapture, onToggleAutoOcr }}
      />

      {/* EXPERIMENTAL OCR capture entry — only present when the feature is
          enabled in the gear panel. Reads the mobiGlas contract screen to
          recover suppressed details; opens a review-before-apply dialog. */}
      {ocrEnabled && (
        <button
          className="sc-ghost-btn"
          onClick={onOcrCapture}
          title="Experimental: capture the mobiGlas contract screen via OCR"
          style={{
            background: "transparent",
            border: "1px solid var(--primary)",
            color: "var(--primary)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 12,
            padding: "8px 13px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          ⊡ Contract Capture
        </button>
      )}
    </header>
  );
}
