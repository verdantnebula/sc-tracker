// ============================================================================
// SettingsGear — the shared ⚙ settings button + its popover (LogFolderPanel).
// ----------------------------------------------------------------------------
// Extracted from the cargo TopBar so every mode's top bar (Cargo, Salvage,
// Mining) renders ONE identical gear menu instead of each re-implementing it.
// The menu houses the app-wide controls: the LIVE folder picker, Re-sync (re-read
// Game.log), Reset Data (cargo/mission data reset), and Collect Logs. The
// EXPERIMENTAL OCR toggle is optional — only the cargo bar passes ocr props, so
// the OCR section is omitted on bars that don't surface it. Everything is
// token-driven, so it skins to the active mode's theme for free.
// ============================================================================

import { useEffect, useState } from "react";
import type { LogPathInfo, UpdateStatus } from "@shared/types";

/** Optional EXPERIMENTAL OCR controls — only the cargo bar wires these. */
type OcrControls = {
  ocrEnabled: boolean;
  onToggleOcr: () => void;
  /** Auto OCR Capture (Phase 3): auto-OCR on accepting a cargo haul. */
  autoOcrCapture: boolean;
  /** Toggle Auto OCR Capture (gated on ocrEnabled — disabled when OCR is off). */
  onToggleAutoOcr: () => void;
};

export function SettingsGear({
  logPathInfo,
  onPickLogFolder,
  onResync,
  onReset,
  onCollectLogs,
  ocr,
}: {
  logPathInfo: LogPathInfo | null;
  /** Open the native folder picker to choose a custom LIVE folder. */
  onPickLogFolder: () => void;
  /** Re-read the Game.log (re-run the logbackups backfill). */
  onResync: () => void;
  /** Wipe cargo/mission data + re-run backfill — destructive, confirmed. */
  onReset: () => void;
  /** Open the "Collect Logs" / Report a Problem dialog. */
  onCollectLogs: () => void;
  /** EXPERIMENTAL OCR toggle — omit to hide the OCR section (Salvage/Mining). */
  ocr?: OcrControls;
}): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
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
          ocr={ocr}
          onChangeFolder={() => {
            setSettingsOpen(false);
            onPickLogFolder();
          }}
          onResync={() => {
            setSettingsOpen(false);
            onResync();
          }}
          onReset={() => {
            setSettingsOpen(false);
            onReset();
          }}
          onCollectLogs={() => {
            setSettingsOpen(false);
            onCollectLogs();
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogFolderPanel — the gear popover. Shows the resolved Game.log path, whether
// it was found, and whether we're on the default vs a custom folder, plus the
// LIVE-folder picker, DATA controls (Re-sync + Reset), Collect Logs, and the
// optional EXPERIMENTAL OCR toggle. Moved here from TopBar so all modes share it.
// ---------------------------------------------------------------------------

function LogFolderPanel({
  info,
  ocr,
  onChangeFolder,
  onResync,
  onReset,
  onCollectLogs,
  onClose,
}: {
  info: LogPathInfo | null;
  ocr?: OcrControls;
  onChangeFolder: () => void;
  /** Re-run the logbackups backfill (relocated from the top bar). */
  onResync: () => void;
  /** Wipe all data + re-run backfill — destructive, confirmed (relocated). */
  onReset: () => void;
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
          // Constrain to the visible window so long content (down to the
          // EXPERIMENTAL/OCR toggle) never clips below the bottom edge — the
          // top bar is ~58px, so leave a small bottom margin. Overflow scrolls
          // inside the popover instead of running off-screen.
          maxHeight: "calc(100vh - 72px)",
          overflowY: "auto",
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

        {/* Divider + DATA controls (Re-sync + Reset) — relocated here from the
            top bar so the header stays uncluttered. Re-sync re-runs the
            logbackups backfill; Reset wipes everything (it confirms first). */}
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
          DATA
        </div>
        <button
          className="sc-ghost-btn"
          onClick={onResync}
          title="Re-run the logbackups backfill"
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
            marginBottom: 8,
          }}
        >
          ⟳ RE-SYNC
        </button>
        <button
          className="sc-ghost-btn"
          onClick={onReset}
          title="Wipe all mission data and re-run backfill"
          style={{
            width: "100%",
            padding: "9px 14px",
            background: "transparent",
            border: "1px solid var(--status-abandoned, #c0556a)",
            color: "var(--status-abandoned, #e08a9a)",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          ⌫ RESET DATA
        </button>

        {/* Divider + UPDATES toggle (auto-update) — app-wide, shown in every
            mode. Self-contained: reads/writes the updateCheckEnabled setting via
            window.api so no prop threading through the three top bars is needed.
            NON-FORCED: when on, the app checks GitHub on launch and downloads a
            newer version in the background, but only installs when the user
            clicks "Restart & Update" in the banner. */}
        <UpdateCheckToggle />

        {/* Divider + EXPERIMENTAL OCR toggle (Phase F) — cargo bar only. */}
        {ocr && (
          <>
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
              EXPERIMENTAL
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                padding: "8px 10px",
                border: "1px solid var(--border-strong)",
                background: ocr.ocrEnabled
                  ? "rgba(52,224,224,0.06)"
                  : "transparent",
              }}
            >
              <input
                type="checkbox"
                checked={ocr.ocrEnabled}
                onChange={ocr.onToggleOcr}
                aria-label="Experimental: OCR contract capture"
                style={{ flex: "none", accentColor: "var(--primary)" }}
              />
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-bright)",
                }}
              >
                OCR contract capture
              </span>
            </label>
            <p
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 10,
                lineHeight: 1.5,
                color: "var(--text-2)",
                margin: "8px 0 0",
              }}
            >
              Reads the mobiGlas contract screen to recover SCU / commodity /
              destination / reward when the game doesn’t log them. Accuracy
              varies — you review and confirm every field before anything is
              applied.
            </p>

            {/* Auto OCR Capture (Phase 3) — DEPENDENT on the OCR toggle above:
                disabled + greyed unless ocrEnabled, since it has nothing to run
                without the OCR fallback. Auto-OCRs the contract screen when you
                accept a cargo haul; requires a calibrated capture region. */}
            <label
              title={
                ocr.ocrEnabled
                  ? "Auto-OCR the contract screen when you accept a cargo haul"
                  : "Enable OCR contract capture first"
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: ocr.ocrEnabled ? "pointer" : "not-allowed",
                padding: "8px 10px",
                marginTop: 10,
                border: "1px solid var(--border-strong)",
                background:
                  ocr.ocrEnabled && ocr.autoOcrCapture
                    ? "rgba(52,224,224,0.06)"
                    : "transparent",
                opacity: ocr.ocrEnabled ? 1 : 0.5,
              }}
            >
              <input
                type="checkbox"
                checked={ocr.ocrEnabled && ocr.autoOcrCapture}
                disabled={!ocr.ocrEnabled}
                onChange={ocr.onToggleAutoOcr}
                aria-label="Experimental: auto-capture contract details"
                style={{ flex: "none", accentColor: "var(--primary)" }}
              />
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 12,
                  fontWeight: 600,
                  color: ocr.ocrEnabled ? "var(--text-bright)" : "var(--muted)",
                }}
              >
                Auto-capture contract details (experimental)
              </span>
            </label>
            <p
              style={{
                fontFamily: "var(--font-display)",
                fontSize: 10,
                lineHeight: 1.5,
                color: "var(--text-2)",
                margin: "8px 0 0",
              }}
            >
              When you accept a cargo haul, this auto-OCRs the contract screen
              and tentatively fills the mission’s legs (you’ll see a “review”
              cue). Requires a calibrated capture region — open Contract Capture
              once to set it.
            </p>
          </>
        )}

        {/* Divider + Report a Problem ("Collect Logs") — kept at the BOTTOM of
            the popover, below Data / Updates / Experimental. */}
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

// ---------------------------------------------------------------------------
// UpdateCheckToggle — self-contained "Automatically check for updates" control.
// ----------------------------------------------------------------------------
// Lives in the gear popover for ALL modes (auto-update is an app-wide setting).
// Reads the persisted flag once on mount and writes it on toggle, both via
// window.api — so it needs no props and no plumbing through the per-mode top
// bars. The change applies on the NEXT launch (we don't tear down a running
// updater mid-session); the copy below says so. Optimistic + confirmed by the
// saved value returned from main.
// ---------------------------------------------------------------------------
/**
 * Map an updater status to the inline status line shown under the
 * "Check for updates" button: its text and a token-driven color (so it themes
 * per mode). Returns null for states we never surface inline here.
 */
function updateStatusLine(
  status: UpdateStatus | null,
): { text: string; color: string } | null {
  switch (status?.state) {
    case "checking":
      return { text: "Checking for updates…", color: "var(--text-2)" };
    case "none":
      return { text: "You’re on the latest version.", color: "var(--success)" };
    case "available":
      return { text: "Update found — downloading…", color: "var(--primary)" };
    case "progress":
      return {
        text: `Downloading update… ${status.percent}%`,
        color: "var(--primary)",
      };
    case "downloaded":
      return {
        text: "Update ready — use the banner above to install.",
        color: "var(--primary)",
      };
    case "error":
      return {
        text: "Couldn’t check for updates (offline or GitHub unavailable).",
        color: "var(--text-2)",
      };
    default:
      return null;
  }
}

function UpdateCheckToggle(): React.JSX.Element {
  const [enabled, setEnabled] = useState(true);
  // Whether the user has clicked "Check for updates" this session. Gates the
  // inline status line so we never show "up to date" before an explicit check.
  const [hasChecked, setHasChecked] = useState(false);
  // Latest updater lifecycle status pushed from main (null until first event).
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void window.api.getUpdateCheckEnabled().then((v) => {
      if (alive) setEnabled(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Subscribe to the updater lifecycle so the inline status line reflects the
  // current check/download state. Clean up the subscription on unmount.
  useEffect(() => {
    const unsubscribe = window.api.onUpdateStatus((s) => setStatus(s));
    return unsubscribe;
  }, []);

  const toggle = (): void => {
    const next = !enabled;
    setEnabled(next); // optimistic
    void window.api.setUpdateCheckEnabled(next).then(setEnabled);
  };

  const checkNow = (): void => {
    setHasChecked(true);
    void window.api.checkForUpdates();
  };

  // Show the inline status line once the user has clicked, OR whenever a
  // download is in progress / ready (so a background download begun before the
  // user clicked is still surfaced here).
  const showStatus =
    hasChecked ||
    status?.state === "available" ||
    status?.state === "progress" ||
    status?.state === "downloaded";
  const statusLine = updateStatusLine(status);

  return (
    <>
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
        UPDATES
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          padding: "8px 10px",
          border: "1px solid var(--border-strong)",
          background: enabled ? "rgba(52,224,224,0.06)" : "transparent",
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={toggle}
          aria-label="Automatically check for updates"
          style={{ flex: "none", accentColor: "var(--primary)" }}
        />
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-bright)",
          }}
        >
          Automatically check for updates
        </span>
      </label>
      <p
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--text-2)",
          margin: "8px 0 0",
        }}
      >
        New versions download in the background. Nothing installs until you
        click “Restart &amp; Update” — never a forced restart. Takes effect next
        launch.
      </p>

      {/* Manual "Check for updates" — styled like the RE-SYNC ghost button.
          Lets the user force a check immediately rather than waiting for the
          launch/periodic check. Results stream in via onUpdateStatus and show
          in the inline line below. */}
      <button
        className="sc-ghost-btn"
        onClick={checkNow}
        title="Check GitHub for a newer version now"
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
          marginTop: 10,
        }}
      >
        ⟳ CHECK FOR UPDATES
      </button>

      {showStatus && statusLine && (
        <p
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 11,
            lineHeight: 1.5,
            color: statusLine.color,
            margin: "8px 0 0",
          }}
        >
          {statusLine.text}
        </p>
      )}
    </>
  );
}
