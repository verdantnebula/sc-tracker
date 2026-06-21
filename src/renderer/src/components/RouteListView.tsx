// RouteListView — the LIST view of the ROUTE tab. Two equal columns over the
// SAME active-mission data: LEFT "TO PICK UP" (load, amber) from pickupGroups,
// RIGHT "TO DROP OFF" (unload, cyan) from dropoffGroups. Each column is a stack
// of per-location group cards (mirroring DropoffGroupCard's look) with checkable
// commodity rows. A station that is both a pickup and a dropoff appears in BOTH
// columns — that's intentional.
//
// Checkboxes commit immediately via onCheckOff (location + commodity), reusing
// the App-level toggle logic: dropoff rows toggle "delivered", pickup rows toggle
// "collected" (pickup-leg completion IS tracked — objectiveCompleted sets a leg's
// `completed` regardless of kind, and updateMission's leg patch is kind-agnostic).
import type { DropoffGroup } from "@shared/types";
import { fmt } from "../lib/selectors";

export function RouteListView({
  pickups,
  dropoffs,
  gap,
  onCheckOffPickup,
  onCheckOffDropoff,
}: {
  pickups: DropoffGroup[];
  dropoffs: DropoffGroup[];
  gap: number;
  /** Toggle a pickup commodity at a location ("collected"). */
  onCheckOffPickup: (location: string, commodity: string) => void;
  /** Toggle a dropoff commodity at a location ("delivered"). */
  onCheckOffDropoff: (location: string, commodity: string) => void;
}): React.JSX.Element {
  const pickupTotal = pickups.reduce((a, g) => a + g.scuRemaining, 0);
  const dropoffTotal = dropoffs.reduce((a, g) => a + g.scuRemaining, 0);

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      <RouteColumn
        title="↑ TO PICK UP"
        accent="var(--secondary)"
        totalScu={pickupTotal}
        groups={pickups}
        gap={gap}
        emptyLabel="Nothing to pick up"
        onCheckOff={onCheckOffPickup}
      />
      <RouteColumn
        title="↓ TO DROP OFF"
        accent="var(--primary)"
        totalScu={dropoffTotal}
        groups={dropoffs}
        gap={gap}
        emptyLabel="Nothing to drop off"
        onCheckOff={onCheckOffDropoff}
      />
    </div>
  );
}

function RouteColumn({
  title,
  accent,
  totalScu,
  groups,
  gap,
  emptyLabel,
  onCheckOff,
}: {
  title: string;
  accent: string;
  totalScu: number;
  groups: DropoffGroup[];
  gap: number;
  emptyLabel: string;
  onCheckOff: (location: string, commodity: string) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap,
      }}
    >
      {/* Column header: title + accent underline + total-SCU chip. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          paddingBottom: 6,
          borderBottom: `2px solid ${accent}`,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 2,
            color: accent,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 700,
            color: accent,
            flex: "none",
          }}
        >
          {fmt(totalScu)} SCU
        </span>
      </div>

      {groups.length === 0 ? (
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 12,
            color: "var(--muted)",
            padding: "10px 4px",
          }}
        >
          {emptyLabel}
        </div>
      ) : (
        groups.map((g) => (
          <RouteGroupCard
            key={g.location}
            group={g}
            accent={accent}
            onCheckOff={onCheckOff}
          />
        ))
      )}
    </div>
  );
}

// One station card — mirrors DropoffGroupCard's look (card-grad bg, notch border,
// header + subtotal chip + commodity rows) but compact + read-focused. The accent
// color (amber for pickup, cyan for dropoff) drives the chip + checkbox borders.
function RouteGroupCard({
  group,
  accent,
  onCheckOff,
}: {
  group: DropoffGroup;
  accent: string;
  onCheckOff: (location: string, commodity: string) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        background: "var(--card-grad)",
        border: `1px solid ${group.isCurrentLocation ? accent : "var(--border)"}`,
        borderRadius: 7,
        padding: 11,
        display: "flex",
        flexDirection: "column",
        gap: 9,
      }}
    >
      {/* Group header: station name + subtotal chip in the column accent. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 500,
            fontSize: 13,
            color: "var(--text-bright)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
          title={group.location}
        >
          {group.location}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 700,
            color: accent,
            flex: "none",
          }}
        >
          {fmt(group.scuRemaining)} SCU
        </span>
      </div>

      {/* Active commodity rows (checkable). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {group.todo.map((line) => (
          <button
            key={line.commodity || "(unknown)"}
            onClick={() => onCheckOff(group.location, line.commodity)}
            title={`Mark ${line.commodity || "(unknown)"} at ${group.location} done`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              padding: "7px 9px",
              background: "var(--window)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              cursor: "pointer",
              textAlign: "left",
              width: "100%",
            }}
          >
            <span
              style={{
                width: 15,
                height: 15,
                flex: "none",
                border: `1.5px solid ${accent}`,
                borderRadius: 3,
                display: "inline-block",
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12.5,
                color: "var(--text)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {line.commodity || "(unknown)"}
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 13,
                color: "var(--text-bright)",
                flex: "none",
              }}
            >
              {fmt(line.scuRemaining)}
            </span>
          </button>
        ))}

        {/* Cleared station (all rows done). */}
        {group.todo.length === 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontFamily: "var(--font-display)",
              fontWeight: 600,
              fontSize: 12,
              color: "var(--success)",
            }}
          >
            ✓ CLEARED
          </div>
        )}
      </div>

      {/* Delivered/collected tray — strike-through, click to undo. */}
      {group.delivered.length > 0 && (
        <div
          style={{
            borderTop: "1px dashed var(--border)",
            paddingTop: 7,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {group.delivered.map((dl) => (
            <button
              key={dl.commodity}
              onClick={() => onCheckOff(group.location, dl.commodity)}
              title={`Undo ${dl.commodity} at ${group.location}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                opacity: 0.5,
                padding: 0,
                width: "100%",
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  color: "var(--muted-done)",
                  textDecoration: "line-through",
                }}
              >
                {dl.commodity}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--muted-done)",
                  textDecoration: "line-through",
                }}
              >
                {fmt(dl.scuDelivered)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
