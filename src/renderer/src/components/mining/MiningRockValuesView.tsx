// ============================================================================
// MiningRockValuesView — the full 26-rock scan-value table.
// ----------------------------------------------------------------------------
// Name, rarity (color-coded by rarity tier), and the six scan-signature values.
// Searchable by name + filterable by rarity. Pure presentation over the bundled
// reference; no mutations. Token-driven so it skins to the MISC theme.
// ============================================================================

import { useMemo, useState } from "react";
import type { MiningReferenceData } from "@shared/types";
import { depositInArea } from "@shared/miningArea";
import {
  fmt,
  rarityColor,
  rarityRank,
  RARITY_ORDER,
  depositForRock,
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
  areaRegions = [],
  onlyNearMe = false,
}: {
  reference: MiningReferenceData;
  /** Deposit regions that count as "near you" (from the resolved body). */
  areaRegions?: string[];
  /** When true, only show rocks whose deposit is minable in the current area. */
  onlyNearMe?: boolean;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [rarity, setRarity] = useState<string>("all");

  // A rock is "near you" if its deposit (matched by name) is in the area. Rocks
  // with no deposit row can't be located, so they're never "near".
  const isNear = useMemo(() => {
    return (rockName: string): boolean => {
      if (areaRegions.length === 0) return false;
      const dep = depositForRock(rockName, reference.deposits);
      return dep ? depositInArea(dep, areaRegions) : false;
    };
  }, [areaRegions, reference.deposits]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reference.rocks
      .filter((r) => (q ? r.name.toLowerCase().includes(q) : true))
      .filter((r) => (rarity === "all" ? true : r.rarity === rarity))
      .filter((r) => (onlyNearMe ? isNear(r.name) : true))
      .slice()
      .sort(
        (a, b) =>
          rarityRank(a.rarity) - rarityRank(b.rarity) ||
          a.name.localeCompare(b.name),
      );
  }, [reference.rocks, search, rarity, onlyNearMe, isNear]);

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
            {rows.map((r) => {
              const near = isNear(r.name);
              return (
                <tr
                  key={r.name}
                  style={
                    near && !onlyNearMe
                      ? { background: "rgba(52,224,224,0.06)" }
                      : undefined
                  }
                >
                  <td
                    style={{
                      ...td,
                      fontWeight: 700,
                      color: "var(--text-bright)",
                    }}
                  >
                    {r.name}
                    {near && (
                      <span
                        title="Minable in your current area"
                        style={{
                          marginLeft: 8,
                          fontFamily: "var(--font-display)",
                          fontSize: 9,
                          fontWeight: 700,
                          letterSpacing: 1,
                          color: "var(--primary)",
                          border: "1px solid var(--primary)",
                          padding: "1px 5px",
                          verticalAlign: "middle",
                        }}
                      >
                        NEAR
                      </span>
                    )}
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
              );
            })}
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
            {onlyNearMe
              ? "No rocks minable in your current area match."
              : "No rocks match."}
          </div>
        )}
      </div>
    </div>
  );
}
