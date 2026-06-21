// Shared contract: the parsed-log domain events.
// The log parser (Phase 2a) maps Game.log lines -> DomainEvent.
// The mission store (Phase 2b) consumes DomainEvent via applyEvent().
// FROZEN CONTRACT — both phases import from here; neither redefines it.
//
// Empirically derived from real Star Citizen Game.log capture (2026-06-19).
// See research-empirical-addendum.md for the source log lines per event.

import type { LegKind, Position } from "./types";

export type CompletionType = "complete" | "abandon";

export type DomainEvent =
  // "Contract Accepted: <title>"  (SHUDEvent_OnNotification) — always present
  | { type: "missionAccepted"; missionId: string; title: string; ts: number }

  // CLocalMissionPhaseMarker::CreateMarker — always present. Carries giver,
  // contract template (encodes commodity/variant/grade), objectiveId, position.
  | {
      type: "missionMarker";
      missionId: string;
      giver: string; // e.g. "Covalex_Hauling", "RedWind_Hauling"
      contractTemplate: string; // e.g. "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade"
      contractDefinitionId?: string;
      objectiveId: string; // e.g. "dropoff_<phase>_0" / "pickup_<phase>_0"
      kind: LegKind;
      position?: Position;
      ts: number;
    }

  // "New Objective: Deliver <done>/<total> SCU of <commodity> to <location>"
  // INTERMITTENT (game token bug suppresses it ~half the time). The ONLY source
  // of SCU amount + human destination name. Absence is handled downstream.
  | {
      type: "objectiveDeclared";
      missionId: string;
      objectiveId: string;
      kind: LegKind;
      commodity: string;
      scuTotal: number;
      location: string;
      ts: number;
    }

  // ObjectiveUpserted / ObjectiveComplete with MISSION_OBJECTIVE_STATE_COMPLETED
  | {
      type: "objectiveCompleted";
      missionId: string;
      objectiveId: string;
      ts: number;
    }

  // EndMission ... CompletionType[Complete|Abandon] Reason[...]  (canonical terminal)
  | {
      type: "missionEnded";
      missionId: string;
      completionType: CompletionType;
      reason: string;
      ts: number;
    }

  // "Awarded <N> aUEC" — payout. MissionId is ALWAYS null in the log; attribute
  // by timestamp correlation to a recent missionEnded (see SPEC §4a).
  | { type: "payoutAwarded"; amount: number; ts: number }

  // "Fined <N> UEC" — penalty (tracked separately from earnings)
  | { type: "fined"; amount: number; ts: number }

  // RequestLocationInventory ... Location[<internalId>] — for currentLocation context
  | { type: "locationInventory"; locationId: string; ts: number };

export type DomainEventType = DomainEvent["type"];
