// ============================================================================
// logger.test.ts — main-process file logger
// ----------------------------------------------------------------------------
// Covers the diagnostics file logger's contract:
//   - formatLine: timestamp + level + rendered args (Errors -> stack/message).
//   - createFileLogger: writes lines to <dir>/main.log on a throwaway temp dir
//     (NEVER the real userData — see memory: never write live app state out of
//     band); rotates to main.log.1 past the cap keeping exactly two files.
//   - unwritable path: a failing fs shim degrades to a no-op + fires onFailure
//     once, never throwing into the caller (the app must keep running).
//   - buildAppInfo / writeAppInfo: snapshot shape + safe-write + swallow on fail.
// All real-fs tests use an OS temp dir that is removed in afterEach.
// ============================================================================

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_LOG_BYTES,
  buildAppInfo,
  createFileLogger,
  formatLine,
  writeAppInfo,
  type LoggerFs,
} from "./logger";

// --- Temp dir scaffolding (throwaway — never the real userData) ---------------

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sc-logger-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatLine
// ---------------------------------------------------------------------------

describe("formatLine", () => {
  it("emits a fixed timestamp, upper-cased level, and joined args", () => {
    const when = new Date("2026-06-20T12:34:56.000Z");
    expect(formatLine("log", ["[main] watching", 42], when)).toBe(
      "2026-06-20T12:34:56.000Z [LOG] [main] watching 42",
    );
  });

  it("renders an Error as its stack or message, not [object Object]", () => {
    const line = formatLine("error", [new Error("boom")]);
    expect(line).toContain("[ERROR]");
    expect(line).toContain("boom");
    expect(line).not.toContain("[object Object]");
  });

  it("never throws on a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLine("warn", [circular])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createFileLogger — writes + rotation
// ---------------------------------------------------------------------------

describe("createFileLogger", () => {
  it("creates the log dir and appends timestamped lines", () => {
    const logger = createFileLogger(dir);
    logger.write("log", ["hello"]);
    logger.write("warn", ["careful"]);

    const contents = readFileSync(logger.logFile, "utf-8");
    const lines = contents.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[LOG] hello");
    expect(lines[1]).toContain("[WARN] careful");
  });

  it("creates a nested log dir that does not exist yet", () => {
    const nested = join(dir, "deep", "logs");
    expect(existsSync(nested)).toBe(false);
    const logger = createFileLogger(nested);
    logger.write("log", ["x"]);
    expect(existsSync(logger.logFile)).toBe(true);
  });

  it("rotates main.log -> main.log.1 once it exceeds the cap, keeping two files", () => {
    const logger = createFileLogger(dir);
    // One big line over the cap forces a rotation on the NEXT write.
    const big = "x".repeat(MAX_LOG_BYTES + 10);
    logger.write("log", [big]);
    expect(existsSync(logger.rotatedFile)).toBe(false); // not rotated yet

    logger.write("log", ["after-rotate"]);
    // The oversized content moved to .1; the active file holds the new line only.
    expect(existsSync(logger.rotatedFile)).toBe(true);
    expect(readFileSync(logger.rotatedFile, "utf-8")).toContain(big);
    const active = readFileSync(logger.logFile, "utf-8");
    expect(active).toContain("after-rotate");
    expect(active).not.toContain(big);
  });

  it("overwrites an existing main.log.1 on a second rotation (at most two files)", () => {
    const logger = createFileLogger(dir);
    const big = "y".repeat(MAX_LOG_BYTES + 10);

    logger.write("log", ["first-gen-big", big]);
    logger.write("log", ["rotate-1"]); // first rotation
    logger.write("log", ["second-gen-big", big]);
    logger.write("log", ["rotate-2"]); // second rotation overwrites .1

    // Only main.log + main.log.1 should exist (no .2, no growth in count).
    expect(existsSync(logger.logFile)).toBe(true);
    expect(existsSync(logger.rotatedFile)).toBe(true);
    expect(existsSync(join(dir, "main.log.2"))).toBe(false);
    expect(readFileSync(logger.logFile, "utf-8")).toContain("rotate-2");
  });
});

// ---------------------------------------------------------------------------
// createFileLogger — unwritable path resilience
// ---------------------------------------------------------------------------

describe("createFileLogger — unwritable filesystem", () => {
  /** An fs shim where every write/mkdir throws, simulating a locked/RO target. */
  function brokenFs(): LoggerFs {
    const boom = (): never => {
      throw new Error("EACCES: permission denied");
    };
    return {
      existsSync: () => false,
      mkdirSync: boom,
      statSync: () => ({ size: 0 }),
      appendFileSync: boom,
      renameSync: boom,
      writeFileSync: boom,
    };
  }

  it("never throws when the log dir/file cannot be written", () => {
    const logger = createFileLogger(dir, { fs: brokenFs() });
    expect(() => logger.write("error", ["this must not throw"])).not.toThrow();
  });

  it("fires onFailure exactly once even across many failed writes", () => {
    const onFailure = vi.fn();
    const logger = createFileLogger(dir, { fs: brokenFs(), onFailure });
    logger.write("log", ["a"]);
    logger.write("log", ["b"]);
    logger.write("log", ["c"]);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// app-info snapshot
// ---------------------------------------------------------------------------

describe("buildAppInfo", () => {
  it("captures the version + runtime + platform/arch + a startedAt timestamp", () => {
    const when = new Date("2026-06-20T00:00:00.000Z");
    const info = buildAppInfo("1.2.3", () => when);
    expect(info.appVersion).toBe("1.2.3");
    expect(info.startedAt).toBe("2026-06-20T00:00:00.000Z");
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    // node version is always present under the test runtime.
    expect(info.node).toBe(process.versions.node);
  });
});

describe("writeAppInfo", () => {
  it("writes pretty JSON to <dir>/app-info.json", () => {
    const info = buildAppInfo("9.9.9", () => new Date("2026-01-01T00:00:00Z"));
    expect(writeAppInfo(dir, info)).toBe(true);
    const onDisk = JSON.parse(
      readFileSync(join(dir, "app-info.json"), "utf-8"),
    );
    expect(onDisk).toEqual(info);
  });

  it("returns false and never throws when the write fails", () => {
    const broken: Pick<LoggerFs, "existsSync" | "mkdirSync" | "writeFileSync"> =
      {
        existsSync: () => true,
        mkdirSync: () => undefined,
        writeFileSync: () => {
          throw new Error("disk full");
        },
      };
    const info = buildAppInfo("1.0.0");
    expect(() => writeAppInfo(dir, info, broken)).not.toThrow();
    expect(writeAppInfo(dir, info, broken)).toBe(false);
  });
});
