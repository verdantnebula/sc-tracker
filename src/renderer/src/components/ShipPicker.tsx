// ============================================================================
// ShipPicker — Phase A. A compact, searchable ship combobox for the TopBar
// (placed AFTER the LOCATION chip, Cargo mode only). It's a native
// <input list> + <datalist> so it's keyboard-searchable with zero extra deps.
//
// Selection MUST resolve to a known ship: the datalist option labels carry the
// ship slug in a data-attribute via a hidden value map, and on change we match
// the typed text back to a ship (by display label) — free text that doesn't
// match a real ship is ignored (the input snaps back to the current ship).
//
// Purely token-driven (var(--primary) etc.); inherits the active cargo theme.
// ============================================================================

import { useMemo, useRef, useState } from "react";
import type { ShipReference } from "@shared/types";

/** The display label shown in the datalist for a ship (name + SCU). */
function shipLabel(s: ShipReference): string {
  const name = s.nameFull && s.nameFull.length > 0 ? s.nameFull : s.name;
  return `${name} · ${s.scu.toLocaleString("en-US")} SCU`;
}

export function ShipPicker({
  ships,
  selectedSlug,
  onSelect,
}: {
  /** Cargo ships (scu > 0), already sorted scu-descending by the snapshot. */
  ships: ShipReference[];
  /** Currently selected ship slug, or null when none is chosen. */
  selectedSlug: string | null;
  /** Persist a selection. Pass the resolved slug, or null to clear. */
  onSelect: (slug: string | null) => void;
}): React.JSX.Element {
  // Defensive: keep the list sorted scu-desc even if a caller passes it unsorted.
  const sorted = useMemo(
    () => [...ships].sort((a, b) => b.scu - a.scu),
    [ships],
  );
  // Map a display label -> ship, so a committed input value resolves to a slug.
  const byLabel = useMemo(() => {
    const m = new Map<string, ShipReference>();
    for (const s of sorted) m.set(shipLabel(s), s);
    return m;
  }, [sorted]);

  const selected = useMemo(
    () => sorted.find((s) => s.slug === selectedSlug) ?? null,
    [sorted, selectedSlug],
  );

  // The text in the box. Mirrors the selected ship's label; while the user is
  // typing it holds their query, and on commit we resolve it back to a ship.
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Resolve the box's current text to a known ship and persist (or clear).
  const commit = (raw: string): void => {
    const value = raw.trim();
    if (value.length === 0) {
      onSelect(null);
    } else {
      const hit = byLabel.get(value);
      if (hit) onSelect(hit.slug);
      // else: unknown free text -> ignore (selection unchanged).
    }
    setEditing(false);
    setText("");
  };

  const displayValue = editing ? text : selected ? shipLabel(selected) : "";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        border: "1px solid var(--border-strong)",
        background: "rgba(52,224,224,0.06)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: 10,
          color: "var(--muted)",
          letterSpacing: 1.5,
          flex: "none",
        }}
      >
        SHIP
      </span>
      <input
        ref={inputRef}
        list="sc-ship-list"
        value={displayValue}
        placeholder="Pick a ship…"
        aria-label="Select cargo ship"
        onFocus={() => {
          setEditing(true);
          setText("");
        }}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
          // Picking from the datalist fires change with the full label — if it
          // resolves to a ship, commit immediately for a one-click feel.
          const hit = byLabel.get(e.target.value);
          if (hit) {
            onSelect(hit.slug);
            setEditing(false);
            setText("");
            inputRef.current?.blur();
          }
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit((e.target as HTMLInputElement).value);
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            setEditing(false);
            setText("");
            inputRef.current?.blur();
          }
        }}
        style={{
          width: 190,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--primary)",
        }}
      />
      <datalist id="sc-ship-list">
        {sorted.map((s) => (
          <option key={s.slug} value={shipLabel(s)} />
        ))}
      </datalist>
    </div>
  );
}
