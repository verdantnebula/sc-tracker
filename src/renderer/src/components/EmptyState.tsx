// EmptyState — design README §8. Centered rotated-diamond frame with a "∅"
// glyph, headline, body, and a primary "ADD MISSION MANUALLY" button.
export function EmptyState({
  onAddManually,
}: {
  onAddManually: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 560,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 18,
        padding: 60,
        textAlign: "center",
      }}
    >
      {/* 66px rotated-diamond frame holding the ∅ glyph */}
      <div
        style={{
          width: 66,
          height: 66,
          border: "1.5px solid var(--border-strong)",
          transform: "rotate(45deg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            transform: "rotate(-45deg)",
            fontSize: 26,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ∅
        </span>
      </div>

      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 21,
          color: "var(--text)",
        }}
      >
        No active cargo missions
      </h1>

      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 14,
          color: "var(--muted)",
          maxWidth: 400,
          lineHeight: 1.55,
        }}
      >
        Accept a hauling contract in-game and it appears here automatically, or
        add one manually to start tracking unloads.
      </p>

      <button
        className="sc-primary-btn"
        onClick={onAddManually}
        style={{
          marginTop: 6,
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: 1,
          color: "#04181a",
          background: "var(--primary)",
          border: "none",
          padding: "11px 22px",
          cursor: "pointer",
          boxShadow: "0 0 20px rgba(52,224,224,0.4)",
        }}
      >
        + ADD MISSION MANUALLY
      </button>
    </div>
  );
}
