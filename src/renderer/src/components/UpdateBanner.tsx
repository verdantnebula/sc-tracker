// ============================================================================
// UpdateBanner — non-blocking, dismissible "update ready" strip (auto-update).
// ----------------------------------------------------------------------------
// Mirrors the LogMissingBanner pattern (full-width strip under the TopBar, theme
// tokens, role="alert") but for the NON-FORCED updater. It NEVER installs on its
// own. Two visible states, driven by the `update:status` push the App subscribes
// to:
//   - "Downloading update… NN%"  (subtle, optional) while a background download
//     runs, so the user knows something is happening — no buttons, can't dismiss
//     a download (nothing to do yet).
//   - "Update vX.Y.Z is ready — [Restart & Update] [Later]" once downloaded. The
//     user decides: "Restart & Update" calls onInstall (the update:install IPC);
//     "Later" dismisses for the session (the downloaded update stays on disk and
//     is NOT auto-installed — no nag, no forced restart).
//
// All other updater states (checking / none / available-but-not-yet-downloaded /
// error) render NOTHING here — the App maps them to either the download view or
// nothing at all. This component is purely presentational; the App owns state.
// ============================================================================

export function UpdateBanner({
  downloadPercent,
  readyVersion,
  onInstall,
  onDismiss,
}: {
  /** 0..100 while a background download runs, or null when not downloading. */
  downloadPercent: number | null;
  /** The downloaded, install-ready version, or null when none is ready. */
  readyVersion: string | null;
  /** User clicked "Restart & Update" — triggers the install IPC. */
  onInstall: () => void;
  /** User clicked "Later" — dismiss for the session (update stays on disk). */
  onDismiss: () => void;
}): React.JSX.Element | null {
  // Ready-to-install takes precedence over an in-flight download (the download
  // just finished). Nothing ready and not downloading -> render nothing.
  if (readyVersion === null && downloadPercent === null) return null;

  const isReady = readyVersion !== null;

  return (
    <div
      role="alert"
      className="sc-update-banner"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 18px",
        // Cyan/primary accent on a near-black surface — distinct from the amber
        // log-missing banner, on-brand with the design tokens.
        background:
          "linear-gradient(180deg, rgba(52,224,224,0.12), rgba(4,16,18,0.55))",
        borderBottom: "1px solid rgba(52,224,224,0.45)",
        boxShadow: "inset 0 1px 0 rgba(52,224,224,0.25)",
      }}
    >
      {/* Icon */}
      <span
        aria-hidden="true"
        style={{
          flex: "none",
          fontSize: 18,
          lineHeight: 1,
          color: "var(--primary)",
          textShadow: "0 0 10px rgba(52,224,224,0.5)",
        }}
      >
        {isReady ? "⬆" : "⟳"}
      </span>

      {/* Message */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 0.3,
            color: "var(--primary)",
          }}
        >
          {isReady
            ? `Update ${readyVersion} is ready to install.`
            : `Downloading update… ${downloadPercent ?? 0}%`}
        </div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 11,
            color: "var(--text-2)",
            marginTop: 3,
            lineHeight: 1.4,
          }}
        >
          {isReady
            ? "Restart when you're ready — nothing installs until you choose."
            : "The app keeps working; we'll let you know when it's ready."}
        </div>
      </div>

      {/* Actions — only when an update is downloaded and ready. */}
      {isReady && (
        <div style={{ flex: "none", display: "flex", gap: 8 }}>
          <button
            className="sc-primary-btn"
            onClick={onInstall}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 15px",
              background: "var(--primary)",
              border: "1px solid var(--primary)",
              color: "#04181a",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.8,
              cursor: "pointer",
              whiteSpace: "nowrap",
              boxShadow: "0 0 16px rgba(52,224,224,0.32)",
            }}
          >
            ⟳ Restart &amp; Update
          </button>
          <button
            className="sc-ghost-btn"
            onClick={onDismiss}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              color: "var(--text-2)",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: 0.8,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}
