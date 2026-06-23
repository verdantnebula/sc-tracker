// ============================================================================
// MiningScanLookupView — the SCAN LOOKUP hero view (Mining mode centerpiece).
// ----------------------------------------------------------------------------
// The player types the value they read off their in-game mining scanner; we
// match it against every rock's six scan-signature values (exact + a small
// tolerance to absorb radar rounding) via the pure lookupScan helper, then show:
//   • the rock name, rarity (rarity-colored), and the matched tier (1..6)
//   • a cross-link to its deposit info (where it's found), matched by name
// Handles no-match ("no rock matches NNNN") and multiple matches (lists all).
// Pure presentation over the bundled reference; no mutations. Token-driven.
// ============================================================================

import { useMemo, useState } from "react";
import type { MiningReferenceData } from "@shared/types";
import {
  lookupScan,
  depositForRock,
  rarityColor,
  fmt,
} from "../../lib/miningSelectors";

// ±1% absorbs radar rounding without bleeding into adjacent rocks (the rock
// bases differ by ~0.3% per row, but a tier value is matched against the SAME
// tier across rocks, where the gap is larger — see lookupScan).
const TOLERANCE_PCT = 1;

export function MiningScanLookupView({
  reference,
}: {
  reference: MiningReferenceData;
}): React.JSX.Element {
  const [raw, setRaw] = useState("");

  const value = Number(raw.replace(/[, ]/g, ""));
  const hasQuery = raw.trim() !== "" && Number.isFinite(value);

  const matches = useMemo(
    () => (hasQuery ? lookupScan(value, reference.rocks, TOLERANCE_PCT) : []),
    [hasQuery, value, reference.rocks],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 760,
        margin: "0 auto",
      }}
    >
      {/* Hero prompt */}
      <div style={{ textAlign: "center", marginTop: 8 }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 22,
            letterSpacing: 1,
            color: "var(--text-bright)",
          }}
        >
          SCAN LOOKUP
        </div>
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "var(--muted)",
            marginTop: 4,
          }}
        >
          Enter the signature value from your mining scanner to identify the
          rock.
        </div>
      </div>

      {/* Big numeric input */}
      <input
        type="number"
        inputMode="numeric"
        value={raw}
        autoFocus
        placeholder="e.g. 8600"
        onChange={(e) => setRaw(e.target.value)}
        style={{
          width: "100%",
          background: "var(--window)",
          border: "2px solid var(--border-strong)",
          color: "var(--text-bright)",
          fontFamily: "var(--font-mono)",
          fontSize: 34,
          fontWeight: 700,
          textAlign: "center",
          padding: "18px 16px",
          outline: "none",
        }}
      />

      {/* Results */}
      {!hasQuery ? (
        <div
          style={{
            textAlign: "center",
            color: "var(--muted)",
            fontFamily: "var(--font-body)",
            fontSize: 13,
            padding: "12px 0",
          }}
        >
          Tolerance ±{TOLERANCE_PCT}% (absorbs radar rounding).
        </div>
      ) : matches.length === 0 ? (
        <div
          role="status"
          style={{
            textAlign: "center",
            color: "var(--danger)",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 16,
            letterSpacing: 0.5,
            padding: "18px 0",
          }}
        >
          No rock matches {fmt(value)}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 11,
              letterSpacing: 1.5,
              color: "var(--muted)",
            }}
          >
            {matches.length === 1 ? "1 MATCH" : `${matches.length} MATCHES`}
          </div>
          {matches.map((m) => (
            <MatchCard
              key={`${m.name}-${m.tier}`}
              match={m}
              deposit={depositForRock(m.name, reference.deposits)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchCard({
  match,
  deposit,
}: {
  match: ReturnType<typeof lookupScan>[number];
  deposit: ReturnType<typeof depositForRock>;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        background: "var(--card-grad)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 20,
            color: "var(--text-bright)",
          }}
        >
          {match.name}
        </span>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1.2,
            color: rarityColor(match.rarity),
            border: `1px solid ${rarityColor(match.rarity)}`,
            padding: "2px 8px",
          }}
        >
          {match.rarity.toUpperCase()}
        </span>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1,
            color: "var(--primary)",
          }}
        >
          TIER {match.tier}
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            color: "var(--text-2)",
          }}
        >
          {fmt(match.tierValue)}
          {match.delta > 0 && (
            <span style={{ color: "var(--muted)" }}>
              {" "}
              (Δ{fmt(match.delta)})
            </span>
          )}
        </span>
      </div>

      {/* Deposit cross-link (where it's found) */}
      <div
        style={{
          fontFamily: "var(--font-body)",
          fontSize: 13,
          color: "var(--text-2)",
          lineHeight: 1.5,
        }}
      >
        {deposit ? (
          <>
            <span style={{ color: "var(--muted)" }}>{deposit.type} · </span>
            {deposit.foundAt.length > 0
              ? deposit.foundAt.join(", ")
              : "Location data unavailable."}
          </>
        ) : (
          <span style={{ color: "var(--muted)" }}>
            No deposit-location data for {match.name}.
          </span>
        )}
      </div>
    </div>
  );
}
