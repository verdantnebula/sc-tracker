// ============================================================================
// SalvageReferenceView — the "is this wreck worth claiming / what's it worth"
// lookup. Three sub-tables sourced from salvage:reference (read-only data):
//   - SHIPS by cost tier: claim cost (incl. org price), CMAT yield, cargo SCU,
//     and the known component loadout — searchable by name, filterable by tier.
//   - COMPONENT PRICES: type filter + model search; class / size / grade / price.
//   - HAULERS: name + cargo-grid SCU, for ferrying the haul.
// Pure presentation over the reference snapshot; no mutations. Token-driven.
// ============================================================================

import { useMemo, useState } from "react";
import type { SalvageReferenceData, SalvageComponentType } from "@shared/types";
import {
  fmt,
  COMPONENT_TYPE_ORDER,
  COMPONENT_TYPE_LABEL,
} from "../../lib/salvageSelectors";

type RefTab = "ships" | "components" | "haulers";

const inputStyle: React.CSSProperties = {
  background: "var(--window)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
  fontFamily: "var(--font-body)",
  fontSize: 13,
  padding: "8px 10px",
  outline: "none",
};

const th: React.CSSProperties = {
  textAlign: "left",
  fontFamily: "var(--font-display)",
  fontSize: 10,
  letterSpacing: 1.2,
  color: "var(--muted)",
  padding: "8px 12px",
  borderBottom: "2px solid var(--border-strong)",
  position: "sticky",
  top: 0,
  background: "var(--surface)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: 13,
  color: "var(--text)",
  padding: "8px 12px",
  borderBottom: "1px solid var(--border)",
};

const tdNum: React.CSSProperties = {
  ...td,
  fontFamily: "var(--font-mono)",
  textAlign: "right",
  color: "var(--text-bright)",
};

const dash = (v: number | string | null): string =>
  v == null || v === "" ? "—" : typeof v === "number" ? fmt(v) : v;

export function SalvageReferenceView({
  reference,
}: {
  reference: SalvageReferenceData;
}): React.JSX.Element {
  const [tab, setTab] = useState<RefTab>("ships");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        maxWidth: 1040,
        margin: "0 auto",
      }}
    >
      {/* sub-tabs */}
      <div style={{ display: "flex", gap: 4 }}>
        {(
          [
            ["ships", `SHIPS (${reference.ships.length})`],
            ["components", `COMPONENTS (${reference.components.length})`],
            ["haulers", `HAULERS (${reference.haulers.length})`],
          ] as [RefTab, string][]
        ).map(([key, label]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                padding: "7px 16px",
                background: active ? "var(--surface-2)" : "transparent",
                border: "1px solid var(--border-strong)",
                borderBottom: active
                  ? "2px solid var(--primary)"
                  : "1px solid var(--border-strong)",
                color: active ? "var(--text-bright)" : "var(--muted)",
                cursor: "pointer",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: 12,
                letterSpacing: 1,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === "ships" && <ShipsTable reference={reference} />}
      {tab === "components" && <ComponentsTable reference={reference} />}
      {tab === "haulers" && <HaulersTable reference={reference} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ships — searchable by name, filterable by cost tier, sorted by tier then CMAT.
// ---------------------------------------------------------------------------

function ShipsTable({
  reference,
}: {
  reference: SalvageReferenceData;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState<string>("all");

  const tiers = useMemo(
    () =>
      Array.from(
        new Set(
          reference.ships
            .map((s) => s.costTier)
            .filter((t): t is number => t != null),
        ),
      ).sort((a, b) => a - b),
    [reference.ships],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reference.ships
      .filter((s) => (q ? s.name.toLowerCase().includes(q) : true))
      .filter((s) => (tier === "all" ? true : String(s.costTier) === tier))
      .slice()
      .sort(
        (a, b) =>
          (a.costTier ?? Infinity) - (b.costTier ?? Infinity) ||
          (b.cmat ?? 0) - (a.cmat ?? 0),
      );
  }, [reference.ships, search, tier]);

  const loadout = (s: SalvageReferenceData["ships"][number]): string => {
    const c = s.components;
    const parts = [c.powerplant, c.shield, c.quantumdrive, c.cooler, c.radar]
      .filter(Boolean)
      .concat(c.weapons);
    return parts.length ? parts.join(", ") : "—";
  };

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          value={search}
          placeholder="Search ship…"
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
        />
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="all">All tiers</option>
          {tiers.map((t) => (
            <option key={t} value={String(t)}>
              Tier {fmt(t)}
            </option>
          ))}
        </select>
      </div>

      <TableShell empty={rows.length === 0} emptyLabel="No ships match.">
        <thead>
          <tr>
            <th style={th}>SHIP</th>
            <th style={{ ...th, textAlign: "right" }}>TIER</th>
            <th style={{ ...th, textAlign: "right" }}>CLAIM</th>
            <th style={{ ...th, textAlign: "right" }}>ORG CLAIM</th>
            <th style={{ ...th, textAlign: "right" }}>CMAT</th>
            <th style={{ ...th, textAlign: "right" }}>CARGO</th>
            <th style={th}>LOADOUT</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.name}>
              <td
                style={{ ...td, fontWeight: 700, color: "var(--text-bright)" }}
              >
                {s.name}
              </td>
              <td style={tdNum}>{dash(s.costTier)}</td>
              <td style={tdNum}>{dash(s.claimCost)}</td>
              <td style={tdNum}>{dash(s.claimCostOrg)}</td>
              <td style={tdNum}>{dash(s.cmat)}</td>
              <td style={tdNum}>{dash(s.cargoScu)}</td>
              <td style={{ ...td, color: "var(--muted)", fontSize: 12 }}>
                {loadout(s)}
              </td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Components — type filter + model search, sorted by price desc.
// ---------------------------------------------------------------------------

function ComponentsTable({
  reference,
}: {
  reference: SalvageReferenceData;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<SalvageComponentType | "all">("all");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reference.components
      .filter((c) => (type === "all" ? true : c.type === type))
      .filter((c) =>
        q
          ? c.model.toLowerCase().includes(q) ||
            (c.class ?? "").toLowerCase().includes(q)
          : true,
      )
      .slice()
      .sort(
        (a, b) =>
          (b.sellPrice ?? -1) - (a.sellPrice ?? -1) ||
          a.model.localeCompare(b.model),
      );
  }, [reference.components, search, type]);

  return (
    <>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          value={search}
          placeholder="Search model / class…"
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
        />
        <select
          value={type}
          onChange={(e) =>
            setType(e.target.value as SalvageComponentType | "all")
          }
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="all">All types</option>
          {COMPONENT_TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {COMPONENT_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>

      <TableShell empty={rows.length === 0} emptyLabel="No components match.">
        <thead>
          <tr>
            <th style={th}>MODEL</th>
            <th style={th}>TYPE</th>
            <th style={th}>CLASS</th>
            <th style={{ ...th, textAlign: "right" }}>SIZE</th>
            <th style={{ ...th, textAlign: "right" }}>GRADE</th>
            <th style={{ ...th, textAlign: "right" }}>PRICE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={`${c.type}-${c.model}-${i}`}>
              <td
                style={{ ...td, fontWeight: 700, color: "var(--text-bright)" }}
              >
                {c.model}
              </td>
              <td style={{ ...td, color: "var(--muted)" }}>
                {COMPONENT_TYPE_LABEL[c.type]}
              </td>
              <td style={{ ...td, color: "var(--muted)" }}>{dash(c.class)}</td>
              <td style={tdNum}>{dash(c.size)}</td>
              <td style={tdNum}>{dash(c.grade)}</td>
              <td
                style={{
                  ...tdNum,
                  color:
                    c.sellPrice != null ? "var(--secondary)" : "var(--muted)",
                  fontWeight: 700,
                }}
              >
                {c.sellPrice != null ? `${fmt(c.sellPrice)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Haulers — name + grid SCU, sorted by capacity desc.
// ---------------------------------------------------------------------------

function HaulersTable({
  reference,
}: {
  reference: SalvageReferenceData;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reference.haulers
      .filter((h) => (q ? h.name.toLowerCase().includes(q) : true))
      .slice()
      .sort((a, b) => b.gridScu - a.gridScu);
  }, [reference.haulers, search]);

  return (
    <>
      <input
        value={search}
        placeholder="Search hauler…"
        onChange={(e) => setSearch(e.target.value)}
        style={{ ...inputStyle, maxWidth: 320 }}
      />
      <TableShell empty={rows.length === 0} emptyLabel="No haulers match.">
        <thead>
          <tr>
            <th style={th}>HAULER</th>
            <th style={{ ...th, textAlign: "right" }}>CARGO GRID (SCU)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.name}>
              <td
                style={{ ...td, fontWeight: 700, color: "var(--text-bright)" }}
              >
                {h.name}
              </td>
              <td style={tdNum}>{fmt(h.gridScu)}</td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared scrollable table chrome.
// ---------------------------------------------------------------------------

function TableShell({
  children,
  empty,
  emptyLabel,
}: {
  children: React.ReactNode;
  empty: boolean;
  emptyLabel: string;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        background: "var(--surface)",
        maxHeight: "60vh",
        overflowY: "auto",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        {children}
      </table>
      {empty && (
        <div
          style={{
            padding: "28px 16px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 13,
          }}
        >
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
