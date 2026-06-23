// DropoffView — design README §3. The "UNLOAD MANIFEST" header + 3-col grid of
// DropoffGroupCards. Aggregation is computed in selectors.dropoffGroups.
import type { DropoffGroup, Mission, ReferenceData } from "@shared/types";
import { fmt } from "../lib/selectors";
import { DropoffGroupCard } from "./DropoffGroupCard";

export function DropoffView({
  groups,
  grandTotal,
  activeStops,
  gap,
  showDelivered,
  missionsById,
  reference,
  onCheckOff,
  onEditLeg,
  onSetDelivered,
  onOpenMission,
}: {
  groups: DropoffGroup[];
  grandTotal: number;
  activeStops: number;
  gap: number;
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
}): React.JSX.Element {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: 13,
            letterSpacing: 2,
            color: "var(--text-2)",
          }}
        >
          UNLOAD MANIFEST
        </div>
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              "linear-gradient(90deg, rgba(86,180,200,0.3), transparent)",
          }}
        />
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          {fmt(grandTotal)} SCU · {activeStops} STOPS
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap,
          alignItems: "stretch",
        }}
      >
        {groups.map((g) => (
          <DropoffGroupCard
            key={g.location}
            group={g}
            showDelivered={showDelivered}
            missionsById={missionsById}
            reference={reference}
            onCheckOff={onCheckOff}
            onEditLeg={onEditLeg}
            onSetDelivered={onSetDelivered}
            onOpenMission={onOpenMission}
          />
        ))}
      </div>
    </>
  );
}
