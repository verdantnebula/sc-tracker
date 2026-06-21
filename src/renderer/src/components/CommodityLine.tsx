// CommodityLine — design README §3. One commodity + summed SCU at a stop.
// Click marks every matching not-done dropoff leg at this location delivered.
import { fmt } from "../lib/selectors";

export function CommodityLine({
  commodity,
  scuRemaining,
  onCheckOff,
}: {
  commodity: string;
  scuRemaining: number;
  onCheckOff: () => void;
}): React.JSX.Element {
  return (
    <div
      className="sc-commodity-line"
      onClick={onCheckOff}
      role="button"
      title={`Mark ${commodity} delivered here`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "9px 10px",
        background: "rgba(52,224,224,0.05)",
        border: "1px solid rgba(86,180,200,0.14)",
        cursor: "pointer",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            flex: "none",
            border: "1.5px solid rgba(86,180,200,0.5)",
            display: "inline-block",
          }}
        />
        <span
          style={{
            fontSize: 13,
            color: "var(--text)",
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {commodity}
        </span>
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 16,
          color: "var(--text-bright)",
          flex: "none",
        }}
      >
        {fmt(scuRemaining)}
      </span>
    </div>
  );
}
