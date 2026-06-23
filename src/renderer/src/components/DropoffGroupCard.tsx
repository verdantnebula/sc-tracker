// DropoffGroupCard — design README §3 (HEADLINE). A destination: hero SCU total,
// combined commodity lines, delivered tray, progress footer. Angular-notch card.
// The "needs a destination" bucket (group.needsLocation) is relabeled as an
// action-oriented amber "SET DESTINATION" card with its lines auto-expanded so
// each leg's inline DestinationPicker is immediately visible.
import type { DropoffGroup, Mission, ReferenceData } from "@shared/types";
import { fmt } from "../lib/selectors";
import { CommodityLine } from "./CommodityLine";

export function DropoffGroupCard({
  group,
  showDelivered,
  missionsById,
  reference,
  onCheckOff,
  onEditLeg,
  onSetDelivered,
  onOpenMission,
}: {
  group: DropoffGroup;
  showDelivered: boolean;
  missionsById: Map<string, Mission>;
  reference: ReferenceData;
  onCheckOff: (location: string, commodity: string) => void;
  onEditLeg: (
    missionId: string,
    legId: string,
    patch: { commodity?: string; scuTotal?: number; location?: string | null },
  ) => void;
  onSetDelivered: (
    missionId: string,
    legId: string,
    scuDelivered: number,
  ) => void;
  onOpenMission: (missionId: string) => void;
}): React.JSX.Element | null {
  const needsLocation = group.needsLocation;
  const hasDelivered = group.delivered.length > 0;
  // Defensive guard: the needs-location ("Set destination") card is an action
  // prompt and is meaningless once its todo is empty (it would render as an
  // already-CLEARED "Set destination" card). The selector already drops such a
  // group, but never render it here even if the data slips through. Normal groups
  // and needs-location groups WITH todo entries are unaffected.
  if (needsLocation && group.todo.length === 0) return null;
  return (
    <div
      style={{
        position: "relative",
        background: "var(--card-grad)",
        border: `1px solid ${
          needsLocation
            ? "var(--secondary)"
            : group.isCurrentLocation
              ? "var(--primary)"
              : "var(--border)"
        }`,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 13,
        clipPath: "var(--notch)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 15,
              color: needsLocation ? "var(--secondary)" : "var(--text-bright)",
              lineHeight: 1.15,
            }}
          >
            {needsLocation
              ? `📍 SET DESTINATION (${group.todo.length})`
              : group.location}
          </div>
          {needsLocation && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-2)",
                fontFamily: "var(--font-body)",
                lineHeight: 1.35,
                maxWidth: 260,
              }}
            >
              These deliveries had no destination in the log — assign one.
            </div>
          )}
          {!needsLocation && group.isCurrentLocation && (
            <div
              style={{
                fontSize: 10,
                letterSpacing: 1.5,
                color: "var(--primary)",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
              }}
            >
              ◈ YOU ARE HERE
            </div>
          )}
        </div>
        {group.allDone && (
          <div
            style={{
              width: 24,
              height: 24,
              flex: "none",
              border: "1px solid var(--success)",
              background: "rgba(84,224,138,0.15)",
              color: "var(--success)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
            }}
          >
            ✓
          </div>
        )}
      </div>

      {/* Active: hero number + commodity lines. The needs-location bucket hides
          the hero (its SCU is usually suppressed to 0) and shows only the
          actionable lines. */}
      {!group.allDone && (
        <>
          {!needsLocation && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontWeight: 700,
                  fontSize: 42,
                  lineHeight: 0.9,
                  color: "var(--primary)",
                  textShadow: "0 0 18px rgba(52,224,224,0.42)",
                }}
              >
                {fmt(group.scuRemaining)}
              </span>
              <span
                style={{
                  fontSize: 11,
                  letterSpacing: 1,
                  color: "var(--muted)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 600,
                }}
              >
                SCU TO
                <br />
                UNLOAD
              </span>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.todo.map((line) => (
              <CommodityLine
                key={line.commodity || "(unknown)"}
                commodity={line.commodity}
                scuRemaining={line.scuRemaining}
                legRefs={line.legRefs}
                missionsById={missionsById}
                reference={reference}
                needsLocation={needsLocation}
                defaultExpanded={needsLocation}
                onCheckOff={() => onCheckOff(group.location, line.commodity)}
                onEditLeg={onEditLeg}
                onSetDelivered={onSetDelivered}
                onOpenMission={onOpenMission}
              />
            ))}
          </div>
        </>
      )}

      {/* Cleared state */}
      {group.allDone && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontWeight: 700,
              fontSize: 30,
              color: "var(--success)",
              lineHeight: 1,
            }}
          >
            CLEARED
          </span>
          <span
            style={{
              fontSize: 12,
              color: "var(--muted)",
              fontFamily: "var(--font-display)",
            }}
          >
            All cargo delivered here
          </span>
        </div>
      )}

      {/* Delivered tray */}
      {hasDelivered && showDelivered && (
        <div
          style={{
            borderTop: "1px dashed rgba(86,180,200,0.18)",
            paddingTop: 9,
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: 1.5,
              color: "var(--success)",
              fontFamily: "var(--font-display)",
              fontWeight: 600,
            }}
          >
            DELIVERED
          </div>
          {group.delivered.map((dl) => (
            <div
              key={dl.commodity}
              onClick={() => onCheckOff(group.location, dl.commodity)}
              role="button"
              title={`Un-deliver ${dl.commodity} here`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                opacity: 0.5,
                cursor: "pointer",
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
            </div>
          ))}
        </div>
      )}

      {/* Progress footer — pinned bottom */}
      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          paddingTop: 4,
        }}
      >
        <div
          style={{
            height: 4,
            background: "rgba(86,180,200,0.12)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${group.pctDelivered}%`,
              background: "var(--success)",
              boxShadow: "0 0 8px rgba(84,224,138,0.6)",
              transition: "width .3s ease",
            }}
          />
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            letterSpacing: 0.5,
          }}
        >
          {group.pctDelivered}% DELIVERED
        </div>
      </div>
    </div>
  );
}
