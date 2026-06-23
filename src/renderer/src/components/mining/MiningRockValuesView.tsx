// ============================================================================
// MiningRockValuesView — the full 26-rock scan-value table.
// ----------------------------------------------------------------------------
// Name, rarity (color-coded by rarity tier), and the six scan-signature values.
// Searchable by name + filterable by rarity. Pure presentation over the bundled
// reference; no mutations. Token-driven so it skins to the MISC theme.
// ============================================================================

import { useMemo, useState } from "react";
import type { MiningReferenceData } from "@shared/types";
import {
  fmt,
  rarityColor,
  rarityRank,
  RARITY_ORDER,
} from "../../lib/miningSelectors";

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

export function MiningRockValuesView({
  reference,
}: {
  reference: MiningReferenceData;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState<string>("all");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reference.rocks
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true))
      .filter((r) => (rarity === "all" ? true : r.rarity === rarity))
      .slice()
      .sort(
        (a, b) =>
          rarityRank(a.rarity) - rarityRank(b.rarity) ||
          a.name.localeCompare(b.name),
      );
  }, [reference.rocks, search, rarity]);

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
          placeholder="Search rock…"
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...inputStyle, flex: 1, minWidth: 180 }}
        />
        <select
          value={rarity}
          onChange={(e) => setRarity(e.target.value)}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="all">All rarities</option>
          {RARITY_ORDER.map((r) => (
            <option key={r} value={r}>
              {r}
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
              <th style={th}>ROCK</th>
              <th style={th}>RARITY</th>
              {[1, 2, 3, 4, 5, 6].map((t) => (
                <th key={t} style={{ ...th, textAlign: "right" }}>
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td
                  style={{
                    ...td,
                    fontWeight: 700,
                    color: "var(--text-bright)",
                  }}
                >
                  {r.name}
                </td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <span
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: 10,
                      letterSpacing: 1,
                      color: rarityColor(r.rarity),
                      border: `1px solid ${rarityColor(r.rarity)}`,
                      padding: "2px 7px",
                    }}
                  >
                    {r.rarity.toUpperCase()}
                  </span>
                </td>
                {r.scanValues.map((v, i) => (
                  <td key={i} style={tdNum}>
                    {fmt(v)}
                  </td>
                ))}
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
            No rocks match.
          </div>
        )}
      </div>
    </div>
  );
}
