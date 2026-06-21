// ============================================================================
// redact.test.ts — identity redaction for the diagnostics "Collect Logs" export
// ----------------------------------------------------------------------------
// The hard requirement: the player handle + GEID + Windows username must be
// stripped (0 hits) from the report, while mission data (mission ids, commodity,
// SCU, location) is PRESERVED so the maintainer can still triage. These tests
// pin both halves of that contract, plus the blanket Player[…]/PlayerId[…] /
// Users\<name> fallbacks and the defensive null/garbage handling.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  detectPlayerIdentity,
  createRedactor,
  REDACTED_PLAYER,
  REDACTED_PLAYER_ID,
  REDACTED_USER,
} from "./redact";

// A representative (synthetic) Game.log slice — uses the real shapes but a
// clearly-fake handle/GEID so the test contains no personal data.
const HANDLE = "NebulaPilot77";
const GEID = "203481910576";
const SAMPLE = [
  `<2026-06-20T21:03:51.975Z> [Notice] <Player[${HANDLE}]> connected PlayerId[${GEID}]`,
  `<2026-06-20T21:03:52.001Z> <SHUDEvent_OnNotification> Added notification "Contract Accepted:  Medium Cargo Haul" [1] to queue. MissionId:[abc-123]`,
  `<2026-06-20T21:03:53.100Z> <SHUDEvent_OnNotification> Added notification "New Objective: Deliver 0/13 SCU of Pressurized Ice to HDPC-Cassillo" [2] to queue. ObjectiveId:[dropoff_xyz_0]`,
  `<2026-06-20T21:03:54.000Z> ${HANDLE}[${GEID}] spawned at terminal`,
  `Loading from C:\\Users\\${"tonysmith"}\\AppData\\Roaming\\sc-cargo-tracker\\settings.json`,
].join("\n");

describe("detectPlayerIdentity", () => {
  it("extracts the handle and GEID from Player[…]/PlayerId[…]", () => {
    const id = detectPlayerIdentity(SAMPLE);
    expect(id.handle).toBe(HANDLE);
    expect(id.geid).toBe(GEID);
  });

  it("recovers the handle from the <handle>[<geid>] combined form", () => {
    const text = `<2026-06-20T00:00:00Z> ${HANDLE}[${GEID}] spawned\nPlayerId[${GEID}]`;
    const id = detectPlayerIdentity(text);
    expect(id.geid).toBe(GEID);
    expect(id.handle).toBe(HANDLE);
  });

  it("returns nulls for a log with no player lines (never throws)", () => {
    const id = detectPlayerIdentity("<2026-06-20T00:00:00Z> nothing here");
    expect(id.handle).toBeNull();
    expect(id.geid).toBeNull();
  });

  it("tolerates non-string input", () => {
    // @ts-expect-error — exercising the defensive guard
    expect(detectPlayerIdentity(null)).toEqual({ handle: null, geid: null });
  });
});

describe("createRedactor — identity stripped, mission data preserved", () => {
  const id = detectPlayerIdentity(SAMPLE);
  const redact = createRedactor(id, "tonysmith");

  it("removes the handle, GEID, and Windows username everywhere (0 hits)", () => {
    const out = redact(SAMPLE);
    expect(out).not.toContain(HANDLE);
    expect(out).not.toContain(GEID);
    expect(out).not.toMatch(/tonysmith/i);
  });

  it("substitutes the redaction tokens", () => {
    const out = redact(SAMPLE);
    expect(out).toContain(REDACTED_PLAYER);
    expect(out).toContain(REDACTED_PLAYER_ID);
    expect(out).toContain(REDACTED_USER);
  });

  it("PRESERVES mission ids, commodity, SCU, and location", () => {
    const out = redact(SAMPLE);
    expect(out).toContain("MissionId:[abc-123]");
    expect(out).toContain("Pressurized Ice");
    expect(out).toContain("13 SCU");
    expect(out).toContain("HDPC-Cassillo");
    expect(out).toContain("dropoff_xyz_0");
  });

  it("blanket-redacts Player[…] / PlayerId[…] even when detection missed", () => {
    // No identity detected -> rely entirely on the blanket structural pass.
    const blanket = createRedactor({ handle: null, geid: null }, null);
    const line = `<Player[SomeoneElse]> id PlayerId[999000111]`;
    const out = blanket(line);
    expect(out).not.toContain("SomeoneElse");
    expect(out).not.toContain("999000111");
    expect(out).toBe(
      `<Player[${REDACTED_PLAYER}]> id PlayerId[${REDACTED_PLAYER_ID}]`,
    );
  });

  it("blanket-redacts a Users\\<name> path even with no username given", () => {
    const blanket = createRedactor({ handle: null, geid: null }, null);
    const out = blanket("C:\\Users\\randomperson\\AppData\\Roaming\\x");
    expect(out).not.toContain("randomperson");
    expect(out).toContain(`Users\\${REDACTED_USER}`);
  });

  it("returns '' for null/undefined and never throws", () => {
    expect(redact(null)).toBe("");
    expect(redact(undefined)).toBe("");
    expect(redact(12345)).toBe("12345");
  });
});
