// ============================================================================
// SalvageTopBar — the salvage shell's 58px header.
// ----------------------------------------------------------------------------
// Carries the shared Cargo<->Salvage switcher (top-left) on the Drake theme,
// plus — for cross-mode consistency — the shared LOCATION chip and the shared
// Settings gear (SettingsGear) reused from the cargo bar. The gear houses the
// app-wide controls (LIVE folder, Re-sync, Reset Data, Collect Logs); since
// Collect Logs now lives inside the gear, the standalone Collect Logs button is
// gone. Everything is token-driven so it skins to the Drake theme for free.
// ============================================================================

import type { LogPathInfo } from "@shared/types";
import { ModeSwitcher } from "./ModeSwitcher";
import { LocationChip } from "./LocationChip";
import { SettingsGear } from "./SettingsGear";

export function SalvageTopBar({
  onToggleMode,
  currentLocation,
  logPathInfo,
  onPickLogFolder,
  onResync,
  onReset,
  onCollectLogs,
}: {
  onToggleMode: () => void;
  /** Player's last-known location — same source the cargo bar/chip uses. */
  currentLocation: string | null;
  /** Resolved Game.log path info for the gear popover. */
  logPathInfo: LogPathInfo | null;
  /** Open the native folder picker to choose a custom LIVE folder. */
  onPickLogFolder: () => void;
  /** Re-read the Game.log (re-run the logbackups backfill). */
  onResync: () => void;
  /** Wipe cargo/mission data + re-run backfill — destructive, confirmed. */
  onReset: () => void;
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

      {/* Location chip — shared component (same source as the cargo bar). */}
      <LocationChip currentLocation={currentLocation} />

      <div style={{ flex: 1 }} />

      {/* Settings (gear) — shared component. App-wide controls (LIVE folder,
          Re-sync, Reset Data, Collect Logs). No OCR section in salvage. */}
      <SettingsGear
        logPathInfo={logPathInfo}
        onPickLogFolder={onPickLogFolder}
        onResync={onResync}
        onReset={onReset}
        onCollectLogs={onCollectLogs}
      />
    </header>
  );
}
