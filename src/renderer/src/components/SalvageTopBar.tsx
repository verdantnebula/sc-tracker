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
}: {
  onToggleMode: () => void;
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

      {/* Right-hand slot reserved for later-phase salvage controls. */}
    </header>
  );
}
