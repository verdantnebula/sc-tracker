import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ocrAssetDir } from "./ocrRecognize";

// Pure path-resolution helper for the main-process OCR module. The actual OCR
// (tesseract.js) needs a real Electron app + worker + a captured frame, so it is
// out of scope for a unit test; this locks down the ASSET-DIR resolution that the
// packaging fix hinges on — the bug was the renderer resolving assets to a path
// trapped inside app.asar. Expectations are built with path.join so they're
// correct on every OS (the helper itself uses path.join).
describe("ocrAssetDir", () => {
  it("resolves the UNPACKED asar path when packaged", () => {
    const dir = ocrAssetDir({
      isPackaged: true,
      resourcesPath: "/app/resources",
      appPath: "/app/resources/app.asar",
    });
    expect(dir).toBe(
      join("/app/resources", "app.asar.unpacked", "out", "renderer", "ocr"),
    );
  });

  it("packaged path lands under app.asar.unpacked (NOT inside app.asar)", () => {
    const dir = ocrAssetDir({
      isPackaged: true,
      resourcesPath: "/app/resources",
      appPath: "/app/resources/app.asar",
    });
    // The whole point of the fix: assets are read as REAL files from
    // app.asar.unpacked, never from inside the (read-only, virtual) app.asar.
    // The only "app.asar" occurrence in the path must be the ".unpacked" one —
    // i.e. there is no app.asar path segment that is NOT followed by .unpacked.
    expect(dir).toContain("app.asar.unpacked");
    expect(dir.replace("app.asar.unpacked", "")).not.toContain("app.asar");
  });

  it("resolves the built-renderer dir in dev (not packaged)", () => {
    const dir = ocrAssetDir({
      isPackaged: false,
      resourcesPath: "/irrelevant/in/dev",
      appPath: "/project/root",
    });
    expect(dir).toBe(join("/project/root", "out", "renderer", "ocr"));
    expect(dir).not.toContain("app.asar");
  });

  it("uses resourcesPath (packaged) vs appPath (dev) as the base", () => {
    const packaged = ocrAssetDir({
      isPackaged: true,
      resourcesPath: "/R",
      appPath: "/A",
    });
    const dev = ocrAssetDir({
      isPackaged: false,
      resourcesPath: "/R",
      appPath: "/A",
    });
    expect(packaged.startsWith(join("/R"))).toBe(true);
    expect(dev.startsWith(join("/A"))).toBe(true);
  });
});
