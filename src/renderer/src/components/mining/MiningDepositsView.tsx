// ============================================================================
// MiningDepositsView — the 61-material deposit reference.
// ----------------------------------------------------------------------------
// Name, type, and FoundAt locations. Searchable by name OR location, and
// filterable by base Type (Ship / Hand / Ground Vehicle Mineable, Harvestable,
// Creature). The source data has rarity-qualified type variants (e.g. "Ship
// Mineable (Rare, Pyro Only)"); the Type filter matches by the BASE category
// (a row whose type STARTS WITH the selected base), so the rare variants are
// grouped with their base type. Pure presentation; no mutations. Token-driven.
// ============================================================================

import { useMemo, useState } from "react";
import type { MiningReferenceData } from "@shared/types";

// Base type categories for the filter. The source type may carry a rarity
// suffix in parentheses; we match by prefix so variants group under their base.
const BASE_TYPES = [
  "Ship Mineable",
  "Hand Mineable",
  "Ground Vehicle Mineable",
  "Harvestable",
  "Creature",
] as const;

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
  verticalAlign: "top",
};

export function MiningDepositsView({
  reference,
}: {
  reference: MiningReferenceData;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reference.deposits
      .filter((d) => (type === "all" ? true : d.type.startsWith(type)))
      .filter((d) =>
        q
          ? d.name.toLowerCase().includes(q) ||
            d.foundAt.some((loc) => loc.toLowerCase().includes(q))
          : true,
      )
      .slice()
      .sort(
        (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
      );
  }, [reference.deposits, search, type]);

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
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input
          value={search}
          placeholder="Search material / location…"
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="all">All types</option>
          {BASE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          background: "var(--surface)",
          maxHeight: "66vh",
          overflowY: "auto",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>MATERIAL</th>
              <th style={th}>TYPE</th>
              <th style={th}>FOUND AT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.name}>
                <td
                  style={{
                    ...td,
                    fontWeight: 700,
                    color: "var(--text-bright)",
                  }}
                >
                  {d.name}
                </td>
                <td
                  style={{ ...td, color: "var(--muted)", whiteSpace: "nowrap" }}
                >
                  {d.type}
                </td>
                <td style={{ ...td, color: "var(--text-2)", lineHeight: 1.5 }}>
                  {d.foundAt.length > 0 ? d.foundAt.join(", ") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div
            style={{
              padding: "28px 16px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            No deposits match.
          </div>
        )}
      </div>
    </div>
  );
}
