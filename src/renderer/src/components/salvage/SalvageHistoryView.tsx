// ============================================================================
// SalvageHistoryView — past salvage runs (sold + abandoned), newest first. The
// salvage analog of cargo's HistoryView, in the same compact-row visual language
// (angular clip, abandoned dimmed). Header readout = lifetime salvage totals.
// Pure: derives everything from the runs list + reference prices via selectors.
// ============================================================================

import type { SalvageRun, SalvageReferenceData } from "@shared/types";
import {
  computeSalvageTotals,
  historyRuns,
  aUEC,
  fmt,
  formatRunDate,
  runMaterialScu,
  RUN_STATUS_META,
} from "../../lib/salvageSelectors";

export function SalvageHistoryView({
  runs,
  reference,
}: {
  runs: SalvageRun[];
  reference: SalvageReferenceData;
}): React.JSX.Element {
  const history = historyRuns(runs);
  const sold = history.filter((r) => r.status === "sold");

  // Lifetime totals across SOLD runs (abandoned runs earned nothing).
  const lifetimeValue = sold.reduce(
    (a, r) => a + computeSalvageTotals(r, reference.materialPrices).totalValue,
    0,
  );
  const lifetimeScu = sold.reduce((a, r) => a + runMaterialScu(r), 0);

  const stat = (value: string, label: string): React.JSX.Element => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 22,
          color: "var(--primary)",
          textShadow: "0 0 12px rgba(242,105,27,0.3)",
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 10,
          letterSpacing: 1,
          color: "var(--muted)",
          fontFamily: "var(--font-display)",
        }}
      >
        {label}
      </span>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 940,
        margin: "0 auto",
      }}
    >
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
          SALVAGE HISTORY
        </div>
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              "linear-gradient(90deg, var(--border-strong), transparent)",
          }}
        />
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          sold runs · ref pricing
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 28,
          padding: "16px 20px",
          border: "1px solid var(--border-strong)",
          background: "rgba(242,105,27,0.05)",
          clipPath: "var(--notch)",
        }}
      >
        {stat(fmt(sold.length), "RUNS SOLD")}
        {stat(fmt(lifetimeScu), "TOTAL MATERIAL SCU")}
        {stat(aUEC(lifetimeValue), "TOTAL EARNED")}
      </div>

      {history.length === 0 ? (
        <div
          style={{
            padding: "40px 20px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 13,
            border: "1px dashed var(--border)",
          }}
        >
          No completed or abandoned runs yet. Sold and abandoned runs appear
          here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {history.map((r) => (
            <HistoryRunRow key={r.id} run={r} reference={reference} />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRunRow({
  run,
  reference,
}: {
  run: SalvageRun;
  reference: SalvageReferenceData;
}): React.JSX.Element {
  const totals = computeSalvageTotals(run, reference.materialPrices);
  const isAbandoned = run.status === "abandoned";
  const meta = RUN_STATUS_META[run.status];
  const soldComponents = run.stripped.filter((s) => s.sold).length;

  return (
    <div
      className="sc-history-row"
      style={{
        background: "var(--card-grad)",
        border: "1px solid var(--border)",
        padding: "11px 14px",
        display: "flex",
        alignItems: "center",
        gap: 14,
        clipPath:
          "polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%)",
        opacity: isAbandoned ? 0.62 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          flex: 1,
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 14,
              color: "var(--text-bright)",
            }}
          >
            {formatRunDate(run.startedAt)}
          </span>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 9,
              letterSpacing: 1,
              padding: "2px 8px",
              color: meta.color,
              background: meta.bg,
              border: `1px solid ${meta.color}`,
            }}
          >
            {meta.label}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            fontSize: 11,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>{run.wrecks.length} wrecks</span>
          <span>·</span>
          <span>
            RMC {fmt(run.rmcScu)} · CMAT {fmt(run.cmatScu)} SCU
          </span>
          <span>·</span>
          <span>
            {soldComponents}/{run.stripped.length} comps sold
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 2,
          flex: "none",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 14,
            color: "var(--secondary)",
          }}
        >
          {aUEC(totals.totalValue)}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--muted)",
          }}
        >
          {aUEC(totals.valuePerPlayer)} ea · ÷{Math.max(1, run.crewSize)}
        </span>
      </div>
    </div>
  );
}
