// TopBar — design README §1. App identity + location chip + LogStatusIndicator
// + Re-sync (backfill) + Settings (LIVE folder) + Manual Add. 58px fixed row.
import { useState } from "react";
import type { LogStatus, LogPathInfo } from "@shared/types";
import { LogStatusIndicator } from "./LogStatusIndicator";
import { ModeSwitcher } from "./ModeSwitcher";

export function TopBar({
  logStatus,
  logPathInfo,
  currentLocation,
  onResync,
  onManualAdd,
  onReset,
  onPickLogFolder,
  onCollectLogs,
  onToggleMode,
}: {
  logStatus: LogStatus | null;
  logPathInfo: LogPathInfo | null;
  currentLocation: string | null;
  onResync: () => void;
  onManualAdd: () => void;
  onReset: () => void;
  /** Open the native folder picker to choose a custom LIVE folder. */
  onPickLogFolder: () => void;
  /** Open the "Collect Logs" / Report a Problem dialog. */
  onCollectLogs: () => void;
  /** Switch to salvage mode (the top-left Cargo<->Salvage switcher). */
  onToggleMode: () => void;
}): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
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

      {/* Location chip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          border: "1px solid rgba(86,180,200,0.22)",
          background: "rgba(52,224,224,0.06)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 10,
            color: "var(--muted)",
            letterSpacing: 1.5,
          }}
        >
          LOCATION
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "var(--primary)",
          }}
        >
          {currentLocation ?? "—"}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      <LogStatusIndicator status={logStatus} onLocate={onPickLogFolder} />

      {/* Settings (gear) — choose a custom StarCitizen \LIVE\ folder */}
      <div style={{ position: "relative" }}>
        <button
          className="sc-ghost-btn"
          onClick={() => setSettingsOpen((v) => !v)}
          aria-label="Log folder settings"
          title="Game.log folder settings"
          aria-expanded={settingsOpen}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 34,
            height: 34,
            background: settingsOpen ? "rgba(52,224,224,0.10)" : "transparent",
            border: `1px solid ${
              settingsOpen ? "var(--primary)" : "var(--border-strong)"
            }`,
            color: settingsOpen ? "var(--primary)" : "var(--text-2)",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ⚙
        </button>

        {settingsOpen && (
          <LogFolderPanel
            info={logPathInfo}
            onChangeFolder={() => {
              setSettingsOpen(false);
              onPickLogFolder();
            }}
            onCollectLogs={() => {
              setSettingsOpen(false);
              onCollectLogs();
            }}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      {/* Re-sync (ghost) */}
      <button
        className="sc-ghost-btn"
        onClick={onResync}
        style={{
          background: "transparent",
          border: "1px solid var(--border-strong)",
          color: "var(--text-2)",
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: 12,
          padding: "8px 13px",
          cursor: "pointer",
        }}
      >
        ⟳ Re-sync
      </button>

      {/* Reset all data (danger ghost) — wipes DB + re-runs backfill (confirmed) */}
      <button
        className="sc-ghost-btn"
        onClick={onReset}
        title="Wipe all mission data and re-run backfill"
        style={{
          background: "transparent",
          border: "1px solid var(--status-abandoned, #c0556a)",
          color: "var(--status-abandoned, #e08a9a)",
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: 12,
          padding: "8px 13px",
          cursor: "pointer",
        }}
      >
        ⌫ Reset Data
      </button>

      {/* Manual Add (primary) */}
      <button
        className="sc-primary-btn"
        onClick={onManualAdd}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 15px",
          background: "var(--primary)",
          border: "1px solid var(--primary)",
          color: "#04181a",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 12,
          letterSpacing: 1,
          cursor: "pointer",
          boxShadow: "0 0 18px rgba(52,224,224,0.38)",
          whiteSpace: "nowrap",
        }}
      >
        + MANUAL ADD
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// LogFolderPanel — the gear popover. Shows the resolved Game.log path, whether
// it was found, and whether we're on the default vs a custom folder, plus a
// button to (re)pick the StarCitizen \LIVE\ folder via the native dialog.
// ---------------------------------------------------------------------------

function LogFolderPanel({
  info,
  onChangeFolder,
  onCollectLogs,
  onClose,
}: {
  info: LogPathInfo | null;
  onChangeFolder: () => void;
  onCollectLogs: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const found = info?.gameLogExists ?? false;
  return (
    <>
      {/* click-away backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 40 }}
      />
      <div
        role="dialog"
        aria-label="Game.log folder settings"
        style={{
          position: "absolute",
          top: "calc(100% + 8px)",
          right: 0,
          zIndex: 41,
          width: 380,
          padding: 16,
          background: "rgba(9,16,21,0.98)",
          border: "1px solid var(--border-strong)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1.5,
            color: "var(--muted)",
            marginBottom: 12,
          }}
        >
          GAME.LOG FOLDER
        </div>

        {/* current path + found state */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "10px 12px",
            border: `1px solid ${
              found ? "rgba(84,224,138,0.3)" : "rgba(255,107,107,0.35)"
            }`,
            background: found
              ? "rgba(84,224,138,0.05)"
              : "rgba(255,107,107,0.05)",
          }}
        >
          <span
            style={{
              flex: "none",
              fontSize: 13,
              color: found ? "var(--success)" : "var(--danger)",
              fontWeight: 700,
            }}
          >
            {found ? "✓" : "✗"}
          </span>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-bright)",
                wordBreak: "break-all",
                lineHeight: 1.4,
              }}
            >
              {info?.gameLogPath ?? "—"}
            </div>
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 10,
                letterSpacing: 0.5,
                color: found ? "var(--success)" : "var(--danger)",
                marginTop: 4,
              }}
            >
              {found ? "Game.log found" : "Game.log not found"}
              {info
                ? info.isDefault
                  ? " · default location"
                  : " · custom folder"
                : ""}
            </div>
          </div>
        </div>

        <p
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--text-2)",
            margin: "12px 0 14px",
          }}
        >
          Installed Star Citizen somewhere non-standard? Point the tracker at
          the
          <code style={{ color: "var(--primary)" }}> \LIVE\ </code>
          folder that contains <code>Game.log</code>. The choice is saved across
          launches.
        </p>

        <button
          className="sc-primary-btn"
          onClick={onChangeFolder}
          style={{
            width: "100%",
            padding: "9px 14px",
            background: "var(--primary)",
            border: "1px solid var(--primary)",
            color: "#04181a",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          CHOOSE \LIVE\ FOLDER…
        </button>

        {/* Divider + Report a Problem ("Collect Logs") */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            margin: "16px 0 12px",
          }}
        />
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1.5,
            color: "var(--muted)",
            marginBottom: 8,
          }}
        >
          SOMETHING WRONG?
        </div>
        <p
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--text-2)",
            margin: "0 0 10px",
          }}
        >
          Collect the logs the developer needs into one file on your Desktop
          (your username + in-game name are removed automatically).
        </p>
        <button
          className="sc-ghost-btn"
          onClick={onCollectLogs}
          style={{
            width: "100%",
            padding: "9px 14px",
            background: "transparent",
            border: "1px solid var(--border-strong)",
            color: "var(--text-bright)",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          🛟 COLLECT LOGS…
        </button>
      </div>
    </>
  );
}
