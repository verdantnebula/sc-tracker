// DestinationPicker — the shared inline destination combobox extracted from
// EditableLegRow. An <input list> backed by a <datalist> over ALL known UEX
// terminals (sorted cargo-centers-first via sortDestinations), with free-text
// entry still allowed for anything not in the snapshot. Used both in the Mission
// Detail panel (EditableLegRow) and the By-Dropoff inline quick-edit so there is
// a single source of truth for "pick a destination".
//
// Controlled-ish: keeps the typed text locally for smooth typing but re-syncs
// when the `value` prop changes (e.g. a live event updated the leg, or a
// different leg reuses this row). onChange fires the raw typed string on every
// keystroke; the caller decides how to interpret "" (typically -> null).
import { useEffect, useId, useState } from "react";
import type { Terminal } from "@shared/types";
import { sortDestinations } from "@shared/location";

export function DestinationPicker({
  value,
  terminals,
  onChange,
  placeholder = "Destination…",
  autoFocus = false,
  ariaLabel,
  style,
}: {
  /** Current destination text (the leg's location, "" when unset). */
  value: string;
  /** Full UEX terminal list; sorted cargo-centers-first internally. */
  terminals: Terminal[];
  /** Fires the raw typed string on every change (caller maps "" -> null). */
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Accessible label for the input (no visible <label> in these dense rows). */
  ariaLabel?: string;
  /** Optional style overrides merged over the default field style. */
  style?: React.CSSProperties;
}): React.JSX.Element {
  // Local controlled text so typing is smooth; re-sync on external value change.
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);

  // Unique datalist id per instance so multiple pickers never collide.
  const listId = useId();

  // Offer EVERY known destination (the bug fix), not just cargo centers — but
  // surface cargo centers first so the common drops are easy to reach. Free-text
  // entry still works for anything not in the list.
  const sorted = sortDestinations(terminals);

  const fieldStyle: React.CSSProperties = {
    background: "var(--window)",
    border: "1px solid rgba(86,180,200,0.25)",
    color: "var(--text)",
    fontFamily: "var(--font-body)",
    fontSize: 12,
    padding: "7px 8px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
    ...style,
  };

  return (
    <>
      <input
        value={text}
        list={listId}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        style={fieldStyle}
      />
      <datalist id={listId}>
        {sorted.map((t) => (
          <option key={t.name} value={t.displayname || t.nickname || t.name} />
        ))}
      </datalist>
    </>
  );
}
