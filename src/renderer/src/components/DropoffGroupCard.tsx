// DropoffGroupCard — design README §3 (HEADLINE). A destination: hero SCU total,
// combined commodity lines, delivered tray, progress footer. Angular-notch card.
import type { DropoffGroup } from "@shared/types";
import { fmt } from "../lib/selectors";
import { CommodityLine } from "./CommodityLine";

export function DropoffGroupCard({
  group,
  showDelivered,
  onCheckOff,
}: {
  group: DropoffGroup;
  showDelivered: boolean;
  onCheckOff: (location: string, commodity: string) => void;
}): React.JSX.Element {
  const hasDelivered = group.delivered.length > 0;
  return (
    <div
      style={{
        position: "relative",
        background: "var(--card-grad)",
        border: `1px solid ${group.isCurrentLocation ? "var(--primary)" : "var(--border)"}`,
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
              color: "var(--text-bright)",
              lineHeight: 1.15,
            }}
          >
            {group.location}
          </div>
          {group.isCurrentLocation && (
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

      {/* Active: hero number + commodity lines */}
      {!group.allDone && (
        <>
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
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.todo.map((line) => (
              <CommodityLine
                key={line.commodity}
                commodity={line.commodity}
                scuRemaining={line.scuRemaining}
                onCheckOff={() => onCheckOff(group.location, line.commodity)}
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
