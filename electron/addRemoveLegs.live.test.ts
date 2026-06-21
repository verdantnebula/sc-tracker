// Live-path verification for add/remove legs: exercises the REAL store against
// an ON-DISK sqlite DB (not :memory:) and proves persistence across a close +
// reopen (== app restart). Isolated temp path; never touches the live app DB.
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { DomainEvent } from "@shared/events";
import { openMissionStore, type MissionStore } from "./missionStore";

const dbPath = join(tmpdir(), `sc-addremove-live-${process.pid}.db`);
const cleanup = (): void => {
  for (const s of ["", "-wal", "-shm"])
    rmSync(`${dbPath}${s}`, { force: true });
};
afterEach(cleanup);

const seed = (store: MissionStore): void => {
  const accepted: DomainEvent = {
    type: "missionAccepted",
    missionId: "MV1",
    title: "Verify Haul",
    ts: 1000,
  };
  const marker: DomainEvent = {
    type: "missionMarker",
    missionId: "MV1",
    giver: "Covalex_Hauling",
    contractTemplate: "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
    objectiveId: "d0",
    kind: "dropoff",
    ts: 1000,
  };
  store.applyEvent(accepted, "live");
  store.applyEvent(marker, "live");
};

describe("add/remove legs — on-disk persistence (restart)", () => {
  it("adds, persists across restart, then removes and persists", () => {
    cleanup();
    let store = openMissionStore({ dbPath, payoutWindowMs: 2000 });
    seed(store);
    expect(store.getMission("MV1")!.legs.length).toBe(1);

    // ADD a 2nd pickup + an extra located dropoff (the UI addLegs patch).
    store.updateMission("MV1", {
      addLegs: [
        {
          kind: "pickup",
          commodity: "Titanium",
          scuTotal: 24,
          location: "Area18",
        },
      ],
    });
    store.updateMission("MV1", {
      addLegs: [
        {
          kind: "dropoff",
          commodity: "Pressurized Ice",
          scuTotal: 30,
          location: "HDPC-Cassillo",
        },
      ],
    });
    let m = store.getMission("MV1")!;
    expect(m.legs.length).toBe(3);
    const pk = m.legs.find(
      (l) => l.kind === "pickup" && l.commodity === "Titanium",
    )!;
    const dz = m.legs.find((l) => l.commodity === "Pressurized Ice")!;
    expect(pk.scuTotal).toBe(24);
    expect(pk.location).toBe("Area18");
    expect(pk.completed).toBe(false);

    // New located dropoff appears in by-dropoff.
    const grp = store
      .dropoffGroups(null)
      .find((g) => g.location === "HDPC-Cassillo")!;
    expect(grp).toBeDefined();
    expect(
      grp.todo.find((c) => c.commodity === "Pressurized Ice")!.scuRemaining,
    ).toBe(30);

    // RESTART: close + reopen the same on-disk DB.
    store.close();
    store = openMissionStore({ dbPath, payoutWindowMs: 2000 });
    expect(store.getMission("MV1")!.legs.length).toBe(3);

    // REMOVE the added pickup, then the added dropoff.
    store.updateMission("MV1", { removeLegIds: [pk.id] });
    expect(store.getMission("MV1")!.legs.some((l) => l.id === pk.id)).toBe(
      false,
    );
    store.updateMission("MV1", { removeLegIds: [dz.id] });
    expect(
      store.dropoffGroups(null).find((g) => g.location === "HDPC-Cassillo"),
    ).toBeUndefined();

    // Removals persist across another restart.
    store.close();
    store = openMissionStore({ dbPath, payoutWindowMs: 2000 });
    m = store.getMission("MV1")!;
    expect(m.legs.length).toBe(1);
    expect(m.legs[0].id).toBe("d0");
    store.close();
  });
});
