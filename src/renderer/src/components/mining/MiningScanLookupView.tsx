// ============================================================================
// MiningScanLookupView — the LOOKUP hero view (Mining mode centerpiece).
// ----------------------------------------------------------------------------
// PRIMARY path: look up a metal by NAME. The player types/selects a metal name;
// we filter the bundled rocks (autocomplete-style) and show the picked metal's
// detail card:
//   • rarity (rarity-colored)
//   • its six SCAN SIGNATURE values (so they know what radar numbers to expect)
//   • its mining TYPE + where it's found (FoundAt), from the deposits data
// SECONDARY path: a small "identify by scan value" toggle keeps the old numeric
// reverse-lookup available for when the player only has a radar number.
// Pure presentation over the bundled reference; no mutations. Token-driven.
// ============================================================================

import { useMemo, useState } from "react";
import type { MiningRock, MiningReferenceData } from "@shared/types";
import {
  searchRocksByName,
  lookupScan,
  depositForRock,
  rarityColor,
  fmt,
} from "../../lib/miningSelectors";

// ±1% absorbs radar rounding without bleeding into adjacent rocks (secondary
// scan-value path only).
const TOLERANCE_PCT = 1;

type Mode = "name" | "scan";

export function MiningScanLookupView({
  reference,
}: {
  reference: MiningReferenceData;
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("name");

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
      {/* Hero prompt + mode toggle */}
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
          {mode === "name" ? "METAL LOOKUP" : "SCAN-VALUE LOOKUP"}
        </div>
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "var(--muted)",
            marginTop: 4,
          }}
        >
          {mode === "name"
            ? "Search a metal by name to see its scan values, rarity, and where it's found."
            : "Enter the signature value from your mining scanner to identify the rock."}
        </div>
        <button
          onClick={() => setMode((m) => (m === "name" ? "scan" : "name"))}
          className="sc-ghost-btn"
          style={{
            marginTop: 10,
            background: "transparent",
            border: "1px solid var(--border-strong)",
            color: "var(--text-2)",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: 11,
            letterSpacing: 1,
            padding: "6px 12px",
            cursor: "pointer",
          }}
        >
          {mode === "name"
            ? "↔ Identify by scan value instead"
            : "↔ Look up by metal name instead"}
        </button>
      </div>

      {mode === "name" ? (
        <NameLookup reference={reference} />
      ) : (
        <ScanLookup reference={reference} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// NAME LOOKUP (primary) — search box with a live autocomplete list; clicking a
// suggestion (or an exact-name match) renders the metal's detail card.
// ---------------------------------------------------------------------------

function NameLookup({
  reference,
}: {
  reference: MiningReferenceData;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<MiningRock | null>(null);

  // Live suggestions as the user types. The picked card is shown independently;
  // typing again (changing the query) re-opens the suggestion list.
  const suggestions = useMemo(
    () => searchRocksByName(query, reference.rocks),
    [query, reference.rocks],
  );

  const showList =
    picked === null || picked.name.toLowerCase() !== query.trim().toLowerCase();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <input
        type="text"
        value={query}
        autoFocus
        placeholder="e.g. Quantainium"
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(null);
        }}
        style={{
          width: "100%",
          background: "var(--window)",
          border: "2px solid var(--border-strong)",
          color: "var(--text-bright)",
          fontFamily: "var(--font-mono)",
          fontSize: 26,
          fontWeight: 700,
          textAlign: "center",
          padding: "16px 16px",
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      {/* Suggestion list (autocomplete) — hidden once a card is shown for the
          exact typed name. */}
      {showList &&
        query.trim() !== "" &&
        (suggestions.length === 0 ? (
          <div
            role="status"
            style={{
              textAlign: "center",
              color: "var(--danger)",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 15,
              letterSpacing: 0.5,
              padding: "16px 0",
            }}
          >
            No metal matches “{query.trim()}”
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              border: "1px solid var(--border-strong)",
              background: "var(--surface)",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {suggestions.map((r) => (
              <button
                key={r.name}
                onClick={() => {
                  setPicked(r);
                  setQuery(r.name);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: 14,
                    color: "var(--text-bright)",
                    flex: 1,
                  }}
                >
                  {r.name}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: 10,
                    letterSpacing: 1,
                    color: rarityColor(r.rarity),
                  }}
                >
                  {r.rarity.toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        ))}

      {/* Detail card for the picked metal */}
      {picked && (
        <MetalDetailCard
          rock={picked}
          deposit={depositForRock(picked.name, reference.deposits)}
        />
      )}

      {/* Idle hint before the user types/picks anything */}
      {query.trim() === "" && !picked && (
        <div
          style={{
            textAlign: "center",
            color: "var(--muted)",
            fontFamily: "var(--font-body)",
            fontSize: 13,
            padding: "12px 0",
          }}
        >
          Start typing a metal name — {reference.rocks.length} mineable rocks in
          the reference.
        </div>
      )}
    </div>
  );
}

// The metal detail card — rarity, six scan values, type + where found.
function MetalDetailCard({
  rock,
  deposit,
}: {
  rock: MiningRock;
  deposit: ReturnType<typeof depositForRock>;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        background: "var(--card-grad)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Header: name + rarity */}
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
            fontSize: 22,
            color: "var(--text-bright)",
          }}
        >
          {rock.name}
        </span>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 1.2,
            color: rarityColor(rock.rarity),
            border: `1px solid ${rarityColor(rock.rarity)}`,
            padding: "2px 8px",
          }}
        >
          {rock.rarity.toUpperCase()}
        </span>
        <div style={{ flex: 1 }} />
        {deposit && (
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: 11,
              letterSpacing: 0.5,
              color: "var(--muted)",
            }}
          >
            {deposit.type}
          </span>
        )}
      </div>

      {/* Scan signature values (the six radar numbers to expect) */}
      <div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 10,
            letterSpacing: 1.5,
            color: "var(--muted)",
            marginBottom: 8,
          }}
        >
          SCAN SIGNATURE VALUES (TIER 1–6)
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: 6,
          }}
        >
          {rock.scanValues.map((v, i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--border)",
                background: "var(--window)",
                padding: "8px 4px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 9,
                  letterSpacing: 1,
                  color: "var(--muted)",
                }}
              >
                T{i + 1}
              </div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 13,
                  fontWeight: 700,
                  color: "var(--text-bright)",
                  marginTop: 2,
                }}
              >
                {fmt(v)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Where it's found */}
      <div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 10,
            letterSpacing: 1.5,
            color: "var(--muted)",
            marginBottom: 6,
          }}
        >
          WHERE IT'S FOUND
        </div>
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 13,
            color: "var(--text-2)",
            lineHeight: 1.6,
          }}
        >
          {deposit && deposit.foundAt.length > 0
            ? deposit.foundAt.join(", ")
            : deposit
              ? "Location data unavailable."
              : `No deposit-location data for ${rock.name}.`}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SCAN LOOKUP (secondary) — the original numeric radar reverse-lookup, kept as
// an opt-in affordance for when the player only has a scanner value.
// ---------------------------------------------------------------------------

function ScanLookup({
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
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
          boxSizing: "border-box",
        }}
      />

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
            <ScanMatchCard
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

function ScanMatchCard({
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
