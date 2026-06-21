// StatusBadge — design README §4 + SPEC §10 delta 2 (adds 4th state Abandoned).
import type { MissionStatus } from "@shared/types";
import { STATUS_META } from "../lib/selectors";

export function StatusBadge({
  status,
  alignStart = false,
}: {
  status: MissionStatus;
  alignStart?: boolean;
}): React.JSX.Element {
  const meta = STATUS_META[status];
  return (
    <span
      style={{
        padding: "3px 8px",
        fontSize: 10,
        letterSpacing: 1,
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.color}`,
        alignSelf: alignStart ? "flex-start" : undefined,
        whiteSpace: "nowrap",
      }}
    >
      {meta.label}
    </span>
  );
}
