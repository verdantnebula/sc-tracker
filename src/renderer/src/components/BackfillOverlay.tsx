// BackfillOverlay — design README §7. First-run / re-sync progress. Driven by
// the REAL backfill:progress payload (BackfillProgress), not a timer.
import type { BackfillProgress } from "@shared/types";

export function BackfillOverlay({
  progress,
}: {
  progress: BackfillProgress;
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, Math.round(progress.progress)));
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 40,
        background: "rgba(4,7,10,0.93)",
        backdropFilter: "blur(4px)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        padding: 40,
        textAlign: "center",
      }}
    >
      <div
        className="sc-spinner"
        style={{
          width: 54,
          height: 54,
          border: "2px solid rgba(52,224,224,0.22)",
          borderTopColor: "var(--primary)",
          boxShadow: "0 0 22px rgba(52,224,224,0.3)",
        }}
      />
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 19,
          color: "var(--text-bright)",
          letterSpacing: 0.5,
        }}
      >
        Backfilling mission history…
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "var(--primary)",
        }}
      >
        {progress.label}
      </div>
      <div
        style={{
          width: 440,
          maxWidth: "100%",
          height: 6,
          background: "rgba(86,180,200,0.14)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "linear-gradient(90deg,#1c9aa0,#34e0e0)",
            boxShadow: "0 0 12px rgba(52,224,224,0.6)",
            transition: "width .25s ease",
          }}
        />
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--muted)",
          letterSpacing: 1,
        }}
      >
        {pct}%
      </div>
    </div>
  );
}
