// RouteView — the ROUTE tab (cargo only). Presents the SAME active-mission data
// two ways via a small MAP | LIST segmented toggle (styled like the By-Dropoff
// density/delivered toggles). LIST (default) shows pickup/dropoff columns; MAP
// shows the node+arrow flow map. The view choice is component-local state — there
// is no persisted-prefs plumbing for it and adding an IPC/settings round-trip for
// a single ephemeral toggle would be out of scope (the brief permits local state).
import { useMemo, useState } from "react";
import type { DropoffGroup, Mission } from "@shared/types";
import { pickupGroups, routeEdges } from "../lib/selectors";
import { RouteListView } from "./RouteListView";
import { RouteMapView } from "./RouteMapView";

type RouteMode = "list" | "map";

export function RouteView({
  activeMissions,
  currentLocation,
  gap,
  dropoffs,
  onCheckOffPickup,
  onCheckOffDropoff,
}: {
  activeMissions: Mission[];
  currentLocation: string | null;
  gap: number;
  /** The dropoff groups already computed by App (same as the By-Dropoff view). */
  dropoffs: DropoffGroup[];
  onCheckOffPickup: (location: string, commodity: string) => void;
  onCheckOffDropoff: (location: string, commodity: string) => void;
}): React.JSX.Element {
  const [routeMode, setRouteMode] = useState<RouteMode>("list");

  const pickups = useMemo(
    () => pickupGroups(activeMissions, currentLocation),
    [activeMissions, currentLocation],
  );
  const edges = useMemo(() => routeEdges(activeMissions), [activeMissions]);

  return (
    <>
      {/* Header: title + MAP|LIST segmented toggle. */}
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
          ROUTE
        </div>
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              "linear-gradient(90deg, rgba(86,180,200,0.3), transparent)",
          }}
        />
        <Segmented
          value={routeMode}
          options={[
            { key: "map", label: "MAP" },
            { key: "list", label: "LIST" },
          ]}
          onChange={setRouteMode}
        />
      </div>

      {routeMode === "list" ? (
        <RouteListView
          pickups={pickups}
          dropoffs={dropoffs}
          gap={gap}
          onCheckOffPickup={onCheckOffPickup}
          onCheckOffDropoff={onCheckOffDropoff}
        />
      ) : (
        <RouteMapView edges={edges} />
      )}
    </>
  );
}

// Small segmented control, styled like the toolbar toggle chips (display font,
// bordered, the active segment uses the primary accent).
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className="sc-ghost-btn"
            style={{
              padding: "4px 12px",
              background: active ? "rgba(52,224,224,0.12)" : "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              fontSize: 10,
              letterSpacing: 1.5,
              color: active ? "var(--primary)" : "var(--muted)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
