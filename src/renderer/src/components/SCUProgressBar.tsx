// SCUProgressBar — design README §4. Delivered-vs-total fill with accent glow.
// 5px track + fill (cyan, or green at 100%), width transitions .3s ease.
export function SCUProgressBar({
  pct,
  legCountStr,
  height = 5,
}: {
  pct: number;
  legCountStr?: string;
  height?: number;
}): React.JSX.Element {
  const color = pct >= 100 ? "var(--success)" : "var(--primary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div
        style={{
          flex: 1,
          height,
          background: "rgba(86,180,200,0.12)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: color,
            boxShadow: `0 0 8px ${color}`,
            transition: "width .3s ease",
          }}
        />
      </div>
      {legCountStr != null && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text-2)",
            minWidth: 70,
            textAlign: "right",
          }}
        >
          {legCountStr}
        </span>
      )}
    </div>
  );
}
