// ============================================================================
// logParsers.test.ts — parser unit tests (SPEC §9, TDD RED -> GREEN)
// ----------------------------------------------------------------------------
// Fixtures are REAL captured Game.log lines (fixtures/sample-events.log). Each
// test asserts parseLine() extracts the exact fields for one event type, across
// both contract givers (Covalex / RedWind) and the noise-suppression cases.
// parseContractTemplate() is covered for both template formats.
// ============================================================================

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { DomainEvent } from "@shared/events";
import {
  parseLine,
  parseContractTemplate,
  commodityDisplayFromToken,
  parseTitleRoute,
} from "./logParsers";

// ---------------------------------------------------------------------------
// Fixture loading helpers
// ---------------------------------------------------------------------------

const fixtureDir = resolve(__dirname, "../fixtures");

function loadLines(file: string): string[] {
  return readFileSync(resolve(fixtureDir, file), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
}

const sampleLines = loadLines("sample-events.log");
const noiseLines = loadLines("noise-lines.log");

/** Parse every fixture line; return only non-null events of a given type. */
function eventsOfType<T extends DomainEvent["type"]>(
  lines: string[],
  type: T,
): Array<Extract<DomainEvent, { type: T }>> {
  return lines
    .map(parseLine)
    .filter((e): e is DomainEvent => e !== null)
    .filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
}

const EPOCH = (iso: string) => new Date(iso).getTime();

// ---------------------------------------------------------------------------
// missionAccepted
// ---------------------------------------------------------------------------

describe("parseLine — missionAccepted", () => {
  it("extracts missionId and trims/strips the <EM4> markup from the title", () => {
    const [e] = eventsOfType(sampleLines, "missionAccepted");
    expect(e).toBeDefined();
    expect(e.missionId).toBe("addd0f67-f57d-4173-a212-7a8f46e4b3fd");
    expect(e.title).toBe("Senior Rank - Medium Cargo Haul");
    expect(e.ts).toBe(EPOCH("2026-06-19T21:03:51.975Z"));
  });

  it("captures all three accepted contracts in the fixture (incl. RedWind)", () => {
    const titles = eventsOfType(sampleLines, "missionAccepted").map(
      (e) => e.title,
    );
    expect(titles).toContain("Senior Rank - Medium Cargo Haul");
    expect(titles).toContain("Junior | Planetary Medium");
    expect(titles).toContain("Rookie Hauler Needed for Direct Small Shipment");
  });
});

// ---------------------------------------------------------------------------
// missionMarker
// ---------------------------------------------------------------------------

describe("parseLine — missionMarker", () => {
  it("extracts giver, template, definitionId, dropoff objectiveId, kind, and xyz position (Covalex)", () => {
    const e = eventsOfType(sampleLines, "missionMarker").find(
      (m) => m.missionId === "addd0f67-f57d-4173-a212-7a8f46e4b3fd",
    )!;
    expect(e).toBeDefined();
    expect(e.giver).toBe("Covalex_Hauling");
    expect(e.contractTemplate).toBe(
      "HaulCargo_SingleToMulti3_Processed_Mixed_PressIceProcFood_Stanton1_SupplyGrade",
    );
    expect(e.contractDefinitionId).toBe("02674975-c818-4535-bffb-e0240be87b26");
    expect(e.objectiveId).toBe(
      "dropoff_b813c5bb-6bc3-4275-9c88-e25760312ac6_0",
    );
    expect(e.kind).toBe("dropoff");
    expect(e.position).toEqual({
      x: -789715.940114,
      y: 615354.400685,
      z: -2353.089599,
    });
    expect(e.ts).toBe(EPOCH("2026-06-19T21:03:51.969Z"));
  });

  it("derives kind=pickup from a pickup_ objectiveId and parses RedWind giver", () => {
    const e = eventsOfType(sampleLines, "missionMarker").find(
      (m) => m.missionId === "c1989ecd-7e2e-4d8d-a2ff-db5411d954b7",
    )!;
    expect(e.giver).toBe("RedWind_Hauling");
    expect(e.contractTemplate).toBe(
      "Redwind_Stanton_SmallGrade_Planetary_Hydrogen",
    );
    expect(e.objectiveId).toBe("pickup_0540719d-0ef2-4e2b-87d5-41ae5cffe412_0");
    expect(e.kind).toBe("pickup");
  });
});

// ---------------------------------------------------------------------------
// objectiveDeclared (New Objective: Deliver done/total SCU of X to Y)
// ---------------------------------------------------------------------------

describe("parseLine — objectiveDeclared", () => {
  it("extracts commodity, scuTotal (the N from done/N), location, kind, ids", () => {
    const e = eventsOfType(sampleLines, "objectiveDeclared").find(
      (o) => o.commodity === "Pressurized Ice",
    )!;
    expect(e).toBeDefined();
    expect(e.missionId).toBe("addd0f67-f57d-4173-a212-7a8f46e4b3fd");
    expect(e.objectiveId).toBe(
      "dropoff_b813c5bb-6bc3-4275-9c88-e25760312ac6_0",
    );
    expect(e.kind).toBe("dropoff");
    expect(e.scuTotal).toBe(13);
    expect(e.location).toBe("HDPC-Cassillo");
  });

  it("parses a larger SCU total and a multi-word location", () => {
    const e = eventsOfType(sampleLines, "objectiveDeclared").find(
      (o) => o.location === "Teasa Spaceport",
    )!;
    expect(e.commodity).toBe("Processed Food");
    expect(e.scuTotal).toBe(188);
  });

  it("parses the RedWind/Waste declared objective (Everus Harbor)", () => {
    const e = eventsOfType(sampleLines, "objectiveDeclared").find(
      (o) => o.location === "Everus Harbor",
    )!;
    expect(e.commodity).toBe("Waste");
    expect(e.scuTotal).toBe(29);
    expect(e.missionId).toBe("132109f5-d08d-4e2e-b856-fd6b1231975b");
  });
});

// ---------------------------------------------------------------------------
// objectiveCompleted (from BOTH ObjectiveUpserted and ObjectiveComplete)
// ---------------------------------------------------------------------------

describe("parseLine — objectiveCompleted", () => {
  it("parses an ObjectiveUpserted COMPLETED line (pickup objective)", () => {
    const all = eventsOfType(sampleLines, "objectiveCompleted");
    const upserted = all.find(
      (o) => o.objectiveId === "pickup_24f233aa-27cf-4a71-97da-1d1d1b8b2a19_0",
    )!;
    expect(upserted).toBeDefined();
    expect(upserted.missionId).toBe("65af15d8-7112-485d-9478-b8039f835015");
  });

  it("parses an ObjectiveComplete COMPLETED line (phase objective)", () => {
    const all = eventsOfType(sampleLines, "objectiveCompleted");
    const complete = all.find(
      (o) => o.objectiveId === "phase_24f233aa-27cf-4a71-97da-1d1d1b8b2a19",
    )!;
    expect(complete).toBeDefined();
    expect(complete.missionId).toBe("65af15d8-7112-485d-9478-b8039f835015");
  });
});

// ---------------------------------------------------------------------------
// parseTitleRoute — title-derived route fallback (FIX 3, location autofill)
// ---------------------------------------------------------------------------
// When the game suppresses the New Objective line, the dropoff location is still
// present in the Contract Accepted title's last `|`-delimited segment. These are
// REAL captured titles (markup tags + trailing tag preserved verbatim).

describe("parseTitleRoute", () => {
  it("parses an A->B (DIRECT) title: <pickup> > <dropoff>, stripping markup", () => {
    const r = parseTitleRoute(
      "Experienced | <EM3>DIRECT</EM3> Large Haul | Seraphim Station > Everus Harbor <EM4>",
    );
    expect(r).toEqual({ pickup: "Seraphim Station", dropoff: "Everus Harbor" });
  });

  it("parses a second real A->B title (Baijini Point > Everus Harbor)", () => {
    const r = parseTitleRoute(
      "Experienced | <EM3>DIRECT</EM3> Medium Haul | Baijini Point > Everus Harbor <EM4>",
    );
    expect(r).toEqual({ pickup: "Baijini Point", dropoff: "Everus Harbor" });
  });

  it("strips a [BP]* contract-modifier token and trailing ':' from the dropoff (real dirty form)", () => {
    // Real captured form: the dropoff endpoint carries a boon/penalty token and a
    // trailing colon. These must NOT leak into the location name, or the stop
    // splits into a second By-Dropoff group and shows a dirty UI label.
    const r = parseTitleRoute(
      "Experienced | <EM3>DIRECT</EM3> Large Haul | Seraphim Station > Everus Harbor [BP]* :",
    );
    expect(r).toEqual({ pickup: "Seraphim Station", dropoff: "Everus Harbor" });
  });

  it("strips [VAR] and multiple bracket tokens from both endpoints", () => {
    const r = parseTitleRoute(
      "Experienced | <EM3>DIRECT</EM3> Haul | Baijini Point [VAR] > Port Tressler [BP]* [VAR] :",
    );
    expect(r).toEqual({ pickup: "Baijini Point", dropoff: "Port Tressler" });
  });

  it("preserves legitimate hyphenated / digit location names (no over-stripping)", () => {
    const r = parseTitleRoute(
      "Experienced | <EM3>DIRECT</EM3> Haul | Area18 > HDPC-Cassillo",
    );
    expect(r).toEqual({ pickup: "Area18", dropoff: "HDPC-Cassillo" });
  });

  it("parses a clean (no-bracket) A->B title unchanged (no regression)", () => {
    const r = parseTitleRoute(
      "Experienced | <EM3>DIRECT</EM3> Haul | Seraphim Station > Everus Harbor",
    );
    expect(r).toEqual({ pickup: "Seraphim Station", dropoff: "Everus Harbor" });
  });

  it("parses a 'from <pickup>' (single-to-multi) title: pickup only, dropoff null", () => {
    const r = parseTitleRoute(
      "Experienced | <EM3>BULK</EM3> Multi Haul | from Baijini Point <EM4>",
    );
    expect(r).toEqual({ pickup: "Baijini Point", dropoff: null });
  });

  it("returns nulls for an unparseable title (no route segment)", () => {
    const r = parseTitleRoute("Senior Rank - Medium Cargo Haul");
    expect(r).toEqual({ pickup: null, dropoff: null });
  });

  it("is defensive: empty / non-string -> nulls, never throws", () => {
    expect(parseTitleRoute("")).toEqual({ pickup: null, dropoff: null });
    // @ts-expect-error testing defensive non-string guard
    expect(parseTitleRoute(undefined)).toEqual({ pickup: null, dropoff: null });
  });
});

// ---------------------------------------------------------------------------
// missionEnded (EndMission, typed CompletionType + Reason)
// ---------------------------------------------------------------------------

describe("parseLine — missionEnded", () => {
  it("parses a Complete EndMission with its reason", () => {
    const e = eventsOfType(sampleLines, "missionEnded").find(
      (m) => m.completionType === "complete",
    )!;
    expect(e).toBeDefined();
    expect(e.missionId).toBe("65af15d8-7112-485d-9478-b8039f835015");
    expect(e.reason).toBe("Mission Ended");
  });

  it("parses an Abandon EndMission with its reason", () => {
    const e = eventsOfType(sampleLines, "missionEnded").find(
      (m) => m.completionType === "abandon",
    )!;
    expect(e).toBeDefined();
    expect(e.missionId).toBe("addd0f67-f57d-4173-a212-7a8f46e4b3fd");
    expect(e.reason).toBe("Player left");
  });
});

// ---------------------------------------------------------------------------
// payoutAwarded / fined
// ---------------------------------------------------------------------------

describe("parseLine — payoutAwarded & fined", () => {
  it("parses Awarded N aUEC as payoutAwarded", () => {
    const [e] = eventsOfType(sampleLines, "payoutAwarded");
    expect(e).toBeDefined();
    expect(e.amount).toBe(28375);
    expect(e.ts).toBe(EPOCH("2026-06-19T22:09:03.788Z"));
  });

  it("parses Fined N UEC as fined (distinct from awarded)", () => {
    const [e] = eventsOfType(sampleLines, "fined");
    expect(e).toBeDefined();
    expect(e.amount).toBe(20000);
  });
});

// ---------------------------------------------------------------------------
// locationInventory
// ---------------------------------------------------------------------------

describe("parseLine — locationInventory", () => {
  it("parses the canonical Location id from RequestLocationInventory", () => {
    const [e] = eventsOfType(sampleLines, "locationInventory");
    expect(e).toBeDefined();
    expect(e.locationId).toBe("Stanton1_DistributionCentre_Hurston_Farnesway");
  });
});

// ---------------------------------------------------------------------------
// Noise suppression — must return null
// ---------------------------------------------------------------------------

describe("parseLine — noise", () => {
  it("returns null for every line in the noise fixture", () => {
    for (const line of noiseLines) {
      expect(parseLine(line)).toBeNull();
    }
  });

  it("returns null for blank/garbage input without throwing", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("totally unrelated text with no timestamp")).toBeNull();
    expect(() =>
      parseLine("<malformed> [Notice] <SHUDEvent_OnNotification> broken"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseContractTemplate
// ---------------------------------------------------------------------------

describe("parseContractTemplate", () => {
  it("Covalex SingleToMulti3 -> SINGLE_TO_MULTI / SUPPLY", () => {
    const r = parseContractTemplate(
      "HaulCargo_SingleToMulti3_Processed_Mixed_PressIceProcFood_Stanton1_SupplyGrade",
    );
    expect(r.variant).toBe("SINGLE_TO_MULTI");
    expect(r.grade).toBe("SUPPLY");
    expect(r.commodityToken).toBe("PressIceProcFood");
  });

  it("Covalex AToB -> A_TO_B / SUPPLY", () => {
    const r = parseContractTemplate(
      "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
    );
    expect(r.variant).toBe("A_TO_B");
    expect(r.grade).toBe("SUPPLY");
    expect(r.commodityToken).toBe("Waste");
  });

  it("Covalex Multi2ToSingle -> MULTI_TO_SINGLE / SUPPLY", () => {
    const r = parseContractTemplate(
      "HaulCargo_Multi2ToSingle_Waste_Waste_Stanton1_SupplyGrade",
    );
    expect(r.variant).toBe("MULTI_TO_SINGLE");
    expect(r.grade).toBe("SUPPLY");
  });

  it("RedWind -> UNKNOWN variant, SMALL grade, commodity from last token", () => {
    const r = parseContractTemplate(
      "Redwind_Stanton_SmallGrade_Planetary_Hydrogen",
    );
    expect(r.variant).toBe("UNKNOWN");
    expect(r.grade).toBe("SMALL");
    expect(r.commodityToken).toBe("Hydrogen");
  });

  it("BulkGrade -> BULK", () => {
    const r = parseContractTemplate(
      "Redwind_Stanton_BulkGrade_Planetary_Titanium",
    );
    expect(r.grade).toBe("BULK");
  });

  it("unrecognized formats fall back to UNKNOWN without throwing", () => {
    const r = parseContractTemplate("SomethingWeird");
    expect(r.variant).toBe("UNKNOWN");
    expect(r.grade).toBe("UNKNOWN");
    expect(() => parseContractTemplate("")).not.toThrow();
  });

  // FIX 2: a clean DISPLAY commodity derived from the template token. Used to
  // auto-fill a leg's commodity when the game suppressed the New Objective line.
  it("derives a clean display commodity from a single-token commodity", () => {
    const r = parseContractTemplate(
      "HaulCargo_AToB_Waste_Waste_Stanton1_SupplyGrade",
    );
    expect(r.commodityDisplay).toBe("Waste");
  });

  it("derives commodity display for RedWind (Hydrogen)", () => {
    const r = parseContractTemplate(
      "Redwind_Stanton_SmallGrade_Planetary_Hydrogen",
    );
    expect(r.commodityDisplay).toBe("Hydrogen");
  });

  it("derives Titanium from a RefinedOre RedWind-style title token", () => {
    const r = parseContractTemplate(
      "Redwind_Stanton_SmallGrade_Planetary_Titanium",
    );
    expect(r.commodityDisplay).toBe("Titanium");
  });

  it("expands a known abbreviation token (PressIce -> Pressurized Ice)", () => {
    const r = parseContractTemplate(
      "Redwind_Stanton_SmallGrade_Planetary_PressIce",
    );
    expect(r.commodityDisplay).toBe("Pressurized Ice");
  });

  it("title-cases / splits CamelCase tokens it doesn't know", () => {
    const r = parseContractTemplate(
      "Redwind_Stanton_SmallGrade_Planetary_ScrapMetal",
    );
    expect(r.commodityDisplay).toBe("Scrap Metal");
  });

  it("commodityDisplay is '' when no commodity token is derivable", () => {
    expect(parseContractTemplate("SomethingWeird").commodityDisplay).toBe("");
    expect(parseContractTemplate("").commodityDisplay).toBe("");
  });
});

describe("commodityDisplayFromToken", () => {
  it("returns '' for empty / non-string", () => {
    expect(commodityDisplayFromToken("")).toBe("");
    // @ts-expect-error defensive: non-string input
    expect(commodityDisplayFromToken(undefined)).toBe("");
  });

  it("expands known abbreviations", () => {
    expect(commodityDisplayFromToken("PressIce")).toBe("Pressurized Ice");
  });

  it("splits CamelCase and title-cases unknown tokens", () => {
    expect(commodityDisplayFromToken("RefinedOre")).toBe("Refined Ore");
    expect(commodityDisplayFromToken("Titanium")).toBe("Titanium");
  });
});
