// Ambient declaration: the preload contextBridge exposes `window.api`.
import type { ApiBridge } from "@shared/ipc";

declare global {
  interface Window {
    api: ApiBridge;
  }
}

export {};
