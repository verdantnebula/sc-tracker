// ============================================================================
// LocationChip — the shared current-location chip used across the mode top bars.
// ----------------------------------------------------------------------------
// Extracted verbatim from the cargo TopBar so Cargo and Salvage (and any future
// bar) render one identical chip. It is purely presentational + token-driven, so
// it skins to whatever mode's theme is active. The value comes from the same
// `currentLocation` source each shell already subscribes to
// (window.api.getCurrentLocation + onCurrentLocationChanged).
//
// Must stay one line: flexShrink:0 keeps it sizing to content (a picker after it
// must not squeeze it), and the value span uses nowrap + ellipsis so a long
// location id (e.g. RR-MIC-LEO) never wraps onto multiple lines inside the chip.
// ============================================================================

export function LocationChip({
  currentLocation,
  /** The small label on the left of the chip. Cargo uses the default. */
  label = "LOCATION",
}: {
  currentLocation: string | null;
  label?: string;
}): React.JSX.Element {
  return (
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
        {label}
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
        {currentLocation ?? "—"}
      </span>
    </div>
  );
}
