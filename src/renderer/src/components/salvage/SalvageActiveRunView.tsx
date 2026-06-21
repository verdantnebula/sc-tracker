// ============================================================================
// SalvageActiveRunView — the salvage tracker's working surface (the analog of
// cargo's by-dropoff view). Owns the live editing of the single active run:
//   - empty state with "Start Salvage Run" when none is open;
//   - RMC / CMAT / Construction SCU material inputs + crew size + notes;
//   - the stripped components list (add via reference dropdowns, qty, sold
//     toggle, remove);
//   - a Drake-orange hero readout: live Total Value + Per-Player, with the
//     RMC / CMAT / component breakdown;
//   - Complete / Sell and Abandon actions.
// Every mutation goes through window.api (passed down as handlers) and the run
// re-renders from the salvage:runs:changed broadcast the parent subscribes to.
// All styling is token-driven so the Drake theme skins it automatically.
// ============================================================================

import { useEffect, useState } from "react";
import type {
  SalvageRun,
  SalvageReferenceData,
  SalvageComponentType,
  StrippedComponentInput,
  StrippedComponentPatch,
} from "@shared/types";
import {
  computeSalvageTotals,
  aUEC,
  fmt,
  componentModelsByType,
  refSellPrice,
  COMPONENT_TYPE_ORDER,
  COMPONENT_TYPE_LABEL,
} from "../../lib/salvageSelectors";

const fieldStyle: React.CSSProperties = {
  background: "var(--window)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
  fontFamily: "var(--font-body)",
  fontSize: 13,
  padding: "8px 9px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

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

export function SalvageActiveRunView({
  run,
  reference,
  onCreateRun,
  onUpdateRun,
  onAddStripped,
  onUpdateStripped,
  onRemoveStripped,
  onCompleteRun,
  onAbandonRun,
}: {
  run: SalvageRun | null;
  reference: SalvageReferenceData;
  onCreateRun: () => void;
  onUpdateRun: (patch: {
    rmcScu?: number;
    cmatScu?: number;
    constructionScu?: number;
    crewSize?: number;
    notes?: string;
  }) => void;
  onAddStripped: (input: StrippedComponentInput) => void;
  onUpdateStripped: (
    componentId: string,
    patch: StrippedComponentPatch,
  ) => void;
  onRemoveStripped: (componentId: string) => void;
  onCompleteRun: () => void;
  onAbandonRun: () => void;
}): React.JSX.Element {
  if (!run) {
    return <SalvageRunEmpty onCreateRun={onCreateRun} />;
  }

  const totals = computeSalvageTotals(run, reference.materialPrices);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 980,
        margin: "0 auto",
      }}
    >
      <HeroReadout totals={totals} crewSize={run.crewSize} />

      {/* Materials + crew + notes */}
      {sectionTitle("RUN INPUTS")}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
        }}
      >
        <ScuField
          label="RMC SCU"
          value={run.rmcScu}
          onCommit={(v) => onUpdateRun({ rmcScu: v })}
        />
        <ScuField
          label="CMAT SCU"
          value={run.cmatScu}
          onCommit={(v) => onUpdateRun({ cmatScu: v })}
        />
        <ScuField
          label="CONSTRUCTION SCU"
          value={run.constructionScu}
          onCommit={(v) => onUpdateRun({ constructionScu: v })}
        />
        <CrewField
          value={run.crewSize}
          onCommit={(v) => onUpdateRun({ crewSize: v })}
        />
      </div>

      <NotesField
        value={run.notes}
        onCommit={(v) => onUpdateRun({ notes: v })}
      />

      {/* Stripped components */}
      {sectionTitle(
        "STRIPPED COMPONENTS",
        `${run.stripped.length} item${run.stripped.length === 1 ? "" : "s"}`,
      )}
      <AddStrippedRow reference={reference} onAdd={onAddStripped} />
      <StrippedList
        run={run}
        onUpdateStripped={onUpdateStripped}
        onRemoveStripped={onRemoveStripped}
      />

      {/* Run actions */}
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "flex-end",
          paddingTop: 6,
        }}
      >
        <button
          className="sc-danger-btn"
          onClick={() => {
            if (
              window.confirm(
                "Abandon this run?\n\nIt moves to History as abandoned and stops being the active run.",
              )
            )
              onAbandonRun();
          }}
          style={{
            padding: "9px 18px",
            background: "transparent",
            border: "1px solid var(--status-abandoned)",
            color: "var(--status-abandoned)",
            cursor: "pointer",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            letterSpacing: 1,
            fontSize: 12,
          }}
        >
          ABANDON
        </button>
        <button
          className="sc-primary-btn"
          onClick={onCompleteRun}
          style={{
            padding: "9px 22px",
            background: "var(--primary)",
            border: "1px solid var(--primary)",
            color: "var(--bg)",
            cursor: "pointer",
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            letterSpacing: 1,
            fontSize: 12,
          }}
        >
          COMPLETE / SELL
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero readout — the big Drake-orange Total + Per-Player with breakdown.
// ---------------------------------------------------------------------------

function HeroReadout({
  totals,
  crewSize,
}: {
  totals: ReturnType<typeof computeSalvageTotals>;
  crewSize: number;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        gap: 28,
        alignItems: "stretch",
        padding: "20px 24px",
        border: "1px solid var(--border-strong)",
        background: "var(--card-grad)",
        clipPath: "var(--notch)",
        boxShadow: "0 0 28px rgba(242,105,27,0.14)",
      }}
    >
      <HeroNumber label="TOTAL VALUE" value={aUEC(totals.totalValue)} big />
      <div style={{ width: 1, background: "var(--border-strong)" }} />
      <HeroNumber
        label={`PER PLAYER · ÷${Math.max(1, crewSize)}`}
        value={aUEC(totals.valuePerPlayer)}
        big
      />
      <div style={{ flex: 1 }} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 6,
          minWidth: 180,
        }}
      >
        <BreakdownRow label="RMC" value={totals.rmcValue} />
        <BreakdownRow label="CMAT" value={totals.cmatValue} />
        <BreakdownRow label="Components" value={totals.componentValue} />
      </div>
    </div>
  );
}

function HeroNumber({
  label,
  value,
  big,
}: {
  label: string;
  value: string;
  big?: boolean;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 800,
          fontSize: big ? 30 : 20,
          color: "var(--primary)",
          textShadow: "0 0 16px rgba(242,105,27,0.4)",
          lineHeight: 1.05,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 10,
          letterSpacing: 1.5,
          color: "var(--muted)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 16,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--muted)" }}>{label}</span>
      <span style={{ color: "var(--text-bright)", fontWeight: 700 }}>
        {fmt(value)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input fields — locally controlled (smooth typing), commit on blur/enter.
// ---------------------------------------------------------------------------

function ScuField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value === 0 ? "" : String(value));
  useEffect(() => {
    setText(value === 0 ? "" : String(value));
  }, [value]);
  const commit = (): void => onCommit(parseInt(text || "0", 10));
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 10,
          letterSpacing: 1.2,
          color: "var(--muted)",
        }}
      >
        {label}
      </span>
      <input
        value={text}
        inputMode="numeric"
        placeholder="0"
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{
          ...fieldStyle,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 16,
          color: "var(--text-bright)",
          textAlign: "right",
        }}
      />
    </label>
  );
}

function CrewField({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}): React.JSX.Element {
  const step = (delta: number): void => onCommit(Math.max(1, value + delta));
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 10,
          letterSpacing: 1.2,
          color: "var(--muted)",
        }}
      >
        CREW SIZE
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          aria-label="Fewer crew"
          onClick={() => step(-1)}
          disabled={value <= 1}
          style={stepBtn(value <= 1)}
        >
          −
        </button>
        <div
          style={{
            ...fieldStyle,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontWeight: 800,
            fontSize: 16,
            color: "var(--text-bright)",
          }}
        >
          {value}
        </div>
        <button
          aria-label="More crew"
          onClick={() => step(1)}
          style={stepBtn(false)}
        >
          +
        </button>
      </div>
    </label>
  );
}

const stepBtn = (disabled: boolean): React.CSSProperties => ({
  width: 38,
  flex: "none",
  background: "var(--surface-2)",
  border: "1px solid var(--border-strong)",
  color: disabled ? "var(--muted-done)" : "var(--primary)",
  cursor: disabled ? "not-allowed" : "pointer",
  fontFamily: "var(--font-mono)",
  fontWeight: 800,
  fontSize: 18,
});

function NotesField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 10,
          letterSpacing: 1.2,
          color: "var(--muted)",
        }}
      >
        NOTES
      </span>
      <textarea
        value={text}
        placeholder="Wrecks claimed, location, who's on the crew…"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onCommit(text)}
        rows={2}
        style={{
          ...fieldStyle,
          resize: "vertical",
          fontFamily: "var(--font-body)",
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Add-stripped row — type dropdown -> model dropdown (prefills price from
// reference, else editable) -> qty -> Add.
// ---------------------------------------------------------------------------

function AddStrippedRow({
  reference,
  onAdd,
}: {
  reference: SalvageReferenceData;
  onAdd: (input: StrippedComponentInput) => void;
}): React.JSX.Element {
  const [type, setType] = useState<SalvageComponentType>("weapon");
  const [model, setModel] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [priceTouched, setPriceTouched] = useState(false);

  const models = componentModelsByType(reference.components, type);

  // When the model changes, prefill price from reference unless the user has
  // typed their own. A null reference price leaves the field empty (user fills).
  const pickModel = (m: string): void => {
    setModel(m);
    if (!priceTouched) {
      const ref = refSellPrice(reference.components, type, m);
      setPrice(ref == null ? "" : String(ref));
    }
  };

  const reset = (): void => {
    setModel("");
    setQty("1");
    setPrice("");
    setPriceTouched(false);
  };

  const canAdd = model.trim() !== "" && parseInt(qty || "0", 10) > 0;

  const add = (): void => {
    if (!canAdd) return;
    onAdd({
      type,
      model: model.trim(),
      qty: parseInt(qty || "0", 10),
      sellPriceEach: parseInt(price || "0", 10),
      sold: false,
    });
    reset();
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr 80px 130px 90px",
        gap: 8,
        alignItems: "end",
        padding: 12,
        border: "1px solid var(--border)",
        background: "var(--surface)",
      }}
    >
      <Field label="TYPE">
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as SalvageComponentType);
            setModel("");
            if (!priceTouched) setPrice("");
          }}
          style={{ ...fieldStyle, cursor: "pointer" }}
        >
          {COMPONENT_TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {COMPONENT_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </Field>

      <Field label="MODEL">
        <input
          value={model}
          list="salvage-models"
          placeholder="Model…"
          onChange={(e) => pickModel(e.target.value)}
          style={fieldStyle}
        />
        <datalist id="salvage-models">
          {models.map((c) => (
            <option key={c.model} value={c.model}>
              {c.sellPrice != null
                ? `${fmt(c.sellPrice)} aUEC`
                : "no ref price"}
            </option>
          ))}
        </datalist>
      </Field>

      <Field label="QTY">
        <input
          value={qty}
          inputMode="numeric"
          onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
          style={{
            ...fieldStyle,
            fontFamily: "var(--font-mono)",
            textAlign: "right",
          }}
        />
      </Field>

      <Field label="PRICE EACH">
        <input
          value={price}
          inputMode="numeric"
          placeholder="0"
          onChange={(e) => {
            setPriceTouched(true);
            setPrice(e.target.value.replace(/[^0-9]/g, ""));
          }}
          style={{
            ...fieldStyle,
            fontFamily: "var(--font-mono)",
            textAlign: "right",
          }}
        />
      </Field>

      <button
        className="sc-add-leg-btn"
        onClick={add}
        disabled={!canAdd}
        style={{
          padding: "8px 0",
          background: canAdd ? "var(--surface-2)" : "transparent",
          border: "1px solid var(--border-strong)",
          color: canAdd ? "var(--primary)" : "var(--muted-done)",
          cursor: canAdd ? "pointer" : "not-allowed",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          letterSpacing: 1,
          fontSize: 12,
        }}
      >
        + ADD
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 9,
          letterSpacing: 1.2,
          color: "var(--muted)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Stripped list — one editable row per pulled component.
// ---------------------------------------------------------------------------

function StrippedList({
  run,
  onUpdateStripped,
  onRemoveStripped,
}: {
  run: SalvageRun;
  onUpdateStripped: (id: string, patch: StrippedComponentPatch) => void;
  onRemoveStripped: (id: string) => void;
}): React.JSX.Element {
  if (run.stripped.length === 0) {
    return (
      <div
        style={{
          padding: "24px 16px",
          textAlign: "center",
          color: "var(--muted)",
          fontSize: 13,
          border: "1px dashed var(--border)",
        }}
      >
        No components stripped yet. Add the parts you pulled off the wreck above
        — only ones marked <strong>sold</strong> count toward the payout.
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {run.stripped.map((c) => (
        <StrippedRow
          key={c.id}
          comp={c}
          onUpdate={(patch) => onUpdateStripped(c.id, patch)}
          onRemove={() => onRemoveStripped(c.id)}
        />
      ))}
    </div>
  );
}

function StrippedRow({
  comp,
  onUpdate,
  onRemove,
}: {
  comp: SalvageRun["stripped"][number];
  onUpdate: (patch: StrippedComponentPatch) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const [qty, setQty] = useState(String(comp.qty));
  const [price, setPrice] = useState(String(comp.sellPriceEach));
  useEffect(() => setQty(String(comp.qty)), [comp.qty]);
  useEffect(() => setPrice(String(comp.sellPriceEach)), [comp.sellPriceEach]);

  const lineValue = comp.qty * comp.sellPriceEach;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 70px 120px 110px 92px 36px",
        gap: 10,
        alignItems: "center",
        padding: "9px 12px",
        background: comp.sold ? "rgba(126,217,87,0.07)" : "var(--surface)",
        borderLeft: `2px solid ${comp.sold ? "var(--success)" : "var(--primary-dim)"}`,
        opacity: comp.sold ? 1 : 0.92,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
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
          {comp.model}
        </span>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 10,
            letterSpacing: 1,
            color: "var(--muted)",
            textTransform: "uppercase",
          }}
        >
          {comp.type}
        </span>
      </div>

      <input
        value={qty}
        inputMode="numeric"
        aria-label="Quantity"
        onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => onUpdate({ qty: parseInt(qty || "0", 10) })}
        style={{
          ...fieldStyle,
          fontFamily: "var(--font-mono)",
          textAlign: "right",
        }}
      />

      <input
        value={price}
        inputMode="numeric"
        aria-label="Price each"
        onChange={(e) => setPrice(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => onUpdate({ sellPriceEach: parseInt(price || "0", 10) })}
        style={{
          ...fieldStyle,
          fontFamily: "var(--font-mono)",
          textAlign: "right",
        }}
      />

      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontSize: 13,
          color: comp.sold ? "var(--secondary)" : "var(--muted)",
          textAlign: "right",
        }}
      >
        {fmt(lineValue)}
      </span>

      <button
        onClick={() => onUpdate({ sold: !comp.sold })}
        title={comp.sold ? "Mark unsold" : "Mark sold"}
        style={{
          padding: "6px 0",
          background: comp.sold ? "rgba(126,217,87,0.16)" : "transparent",
          border: `1px solid ${comp.sold ? "var(--success)" : "var(--border-strong)"}`,
          color: comp.sold ? "var(--success)" : "var(--muted)",
          cursor: "pointer",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: 11,
          letterSpacing: 1,
        }}
      >
        {comp.sold ? "✓ SOLD" : "SELL?"}
      </button>

      <button
        className="sc-danger-btn"
        onClick={onRemove}
        title="Remove component"
        aria-label="Remove component"
        style={{
          width: 30,
          height: 30,
          background: "transparent",
          border: "1px solid var(--border-strong)",
          color: "var(--status-abandoned)",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — no active run.
// ---------------------------------------------------------------------------

function SalvageRunEmpty({
  onCreateRun,
}: {
  onCreateRun: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        height: "100%",
        minHeight: 480,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          border: "2px solid var(--border-strong)",
          background: "var(--surface)",
          boxShadow: "0 0 28px rgba(242,105,27,0.22)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 30,
          color: "var(--primary)",
        }}
      >
        ⛏
      </div>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 20,
          color: "var(--text-bright)",
        }}
      >
        NO ACTIVE SALVAGE RUN
      </h1>
      <p
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 14,
          color: "var(--muted)",
          maxWidth: 420,
          lineHeight: 1.55,
        }}
      >
        Start a run to log RMC / CMAT yields and the components you strip, then
        sell and split the haul across your crew.
      </p>
      <button
        className="sc-primary-btn"
        onClick={onCreateRun}
        style={{
          padding: "11px 26px",
          background: "var(--primary)",
          border: "1px solid var(--primary)",
          color: "var(--bg)",
          cursor: "pointer",
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          letterSpacing: 1,
          fontSize: 13,
        }}
      >
        START SALVAGE RUN
      </button>
    </div>
  );
}
