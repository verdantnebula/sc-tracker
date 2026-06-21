// ============================================================================
// SalvageSellSplitView — the salvage analog of cargo's By-Dropoff view. For the
// ACTIVE run it answers "what do I sell and what does everyone earn":
//   - materials itemized (RMC × price, CMAT × price);
//   - components grouped by type, each line showing qty, price, sold state and
//     line value (the sold toggle is live here too, so selling can be ticked off
//     from this screen as the haul is offloaded);
//   - a running Total;
//   - a prominent per-player split readout ("each of N gets X aUEC").
// Pure derivations come from salvageSelectors; mutations go through window.api
// handlers passed down from the shell. Token-driven → Drake-themed automatically.
// ============================================================================

import type {
  SalvageRun,
  SalvageReferenceData,
  StrippedComponentPatch,
} from "@shared/types";
import {
  computeSalvageTotals,
  groupStripped,
  aUEC,
  fmt,
  COMPONENT_TYPE_LABEL,
} from "../../lib/salvageSelectors";

const sectionTitle = (label: string, trailing?: string): React.JSX.Element => (
  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
    <div
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: 13,
        letterSpacing: 2,
        color: "var(--text-2)",
      }}
    >
      {label}
    </div>
    <div
      style={{
        flex: 1,
        height: 1,
        background: "linear-gradient(90deg, var(--border-strong), transparent)",
      }}
    />
    {trailing && (
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--muted)",
        }}
      >
        {trailing}
      </div>
    )}
  </div>
);

export function SalvageSellSplitView({
  run,
  reference,
  onUpdateStripped,
}: {
  run: SalvageRun | null;
  reference: SalvageReferenceData;
  onUpdateStripped: (
    componentId: string,
    patch: StrippedComponentPatch,
  ) => void;
}): React.JSX.Element {
  if (!run) {
    return (
      <div
        style={{
          padding: "60px 20px",
          textAlign: "center",
          color: "var(--muted)",
          fontSize: 14,
          maxWidth: 520,
          margin: "0 auto",
        }}
      >
        No active run to sell. Start one on the{" "}
        <strong style={{ color: "var(--primary)" }}>Active Run</strong> tab, log
        your materials and components, then come back here to tally the sale and
        split it across the crew.
      </div>
    );
  }

  const prices = reference.materialPrices;
  const totals = computeSalvageTotals(run, prices);
  const groups = groupStripped(run.stripped);
  const crew = Math.max(1, run.crewSize);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      {/* Per-player split — the headline answer. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "20px 26px",
          border: "1px solid var(--border-strong)",
          background: "var(--card-grad)",
          clipPath: "var(--notch)",
          boxShadow: "0 0 28px rgba(242,105,27,0.14)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 11,
              letterSpacing: 1.5,
              color: "var(--muted)",
            }}
          >
            EACH OF {crew} {crew === 1 ? "PLAYER GETS" : "PLAYERS GETS"}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 800,
              fontSize: 34,
              color: "var(--primary)",
              textShadow: "0 0 16px rgba(242,105,27,0.4)",
              lineHeight: 1,
            }}
          >
            {aUEC(totals.valuePerPlayer)}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: "flex-end",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 11,
              letterSpacing: 1.5,
              color: "var(--muted)",
            }}
          >
            HAUL TOTAL
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 22,
              color: "var(--text-bright)",
            }}
          >
            {aUEC(totals.totalValue)}
          </span>
        </div>
      </div>

      {/* Materials */}
      {sectionTitle("MATERIALS")}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <MaterialRow
          label="RMC"
          scu={run.rmcScu}
          perScu={prices.rmcPerScu}
          value={totals.rmcValue}
        />
        <MaterialRow
          label="CMAT"
          scu={run.cmatScu}
          perScu={prices.cmatPerScu}
          value={totals.cmatValue}
        />
        {run.constructionScu > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 14px",
              border: "1px dashed var(--border)",
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            <span>Construction · {fmt(run.constructionScu)} SCU</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>
              no agreed price — excluded from total
            </span>
          </div>
        )}
      </div>

      {/* Components */}
      {sectionTitle("COMPONENTS", `sold ${fmt(totals.componentValue)} aUEC`)}
      {groups.length === 0 ? (
        <div
          style={{
            padding: "20px 16px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 13,
            border: "1px dashed var(--border)",
          }}
        >
          No components stripped. Add them on the Active Run tab.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {groups.map((g) => (
            <div
              key={g.type}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: 11,
                  letterSpacing: 1.5,
                  color: "var(--text-2)",
                }}
              >
                <span>{COMPONENT_TYPE_LABEL[g.type]}</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--secondary)",
                  }}
                >
                  {fmt(g.soldValue)} / {fmt(g.grossValue)} aUEC
                </span>
              </div>
              {g.lines.map((line) => (
                <ComponentLineRow
                  key={`${line.model}-${line.sellPriceEach}-${line.sold}`}
                  model={line.model}
                  qty={line.qty}
                  priceEach={line.sellPriceEach}
                  value={line.lineValue}
                  sold={line.sold}
                  onToggleSold={() =>
                    line.ids.forEach((id) =>
                      onUpdateStripped(id, { sold: !line.sold }),
                    )
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MaterialRow({
  label,
  scu,
  perScu,
  value,
}: {
  label: string;
  scu: number;
  perScu: number;
  value: number;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "11px 14px",
        background: "var(--surface)",
        borderLeft: "2px solid var(--primary-dim)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 14,
            color: "var(--text-bright)",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {fmt(scu)} SCU × {fmt(perScu)}
        </span>
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 14,
          color: "var(--secondary)",
        }}
      >
        {fmt(value)} aUEC
      </span>
    </div>
  );
}

function ComponentLineRow({
  model,
  qty,
  priceEach,
  value,
  sold,
  onToggleSold,
}: {
  model: string;
  qty: number;
  priceEach: number;
  value: number;
  sold: boolean;
  onToggleSold: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 150px 110px 92px",
        gap: 12,
        alignItems: "center",
        padding: "9px 14px",
        background: sold ? "rgba(126,217,87,0.06)" : "var(--surface)",
        borderLeft: `2px solid ${sold ? "var(--success)" : "var(--border-strong)"}`,
        opacity: sold ? 1 : 0.72,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 13,
          color: "var(--text-bright)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {model}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--muted)",
          textAlign: "right",
        }}
      >
        {fmt(qty)} × {fmt(priceEach)}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 13,
          color: sold ? "var(--secondary)" : "var(--muted)",
          textAlign: "right",
        }}
      >
        {fmt(value)}
      </span>
      <button
        onClick={onToggleSold}
        title={sold ? "Mark unsold" : "Mark sold"}
        style={{
          padding: "6px 0",
          background: sold ? "rgba(126,217,87,0.16)" : "transparent",
          border: `1px solid ${sold ? "var(--success)" : "var(--border-strong)"}`,
          color: sold ? "var(--success)" : "var(--muted)",
          cursor: "pointer",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: 1,
        }}
      >
        {sold ? "✓ SOLD" : "SELL?"}
      </button>
    </div>
  );
}
