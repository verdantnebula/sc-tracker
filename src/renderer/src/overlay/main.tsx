// ============================================================================
// overlay/main.tsx — entry for the always-on-top "next stop" overlay window.
// ----------------------------------------------------------------------------
// Loaded by createOverlay() in the main process (overlay.html). Mounts the
// compact OverlayApp into a transparent, frameless window. Reuses the SAME design
// tokens + global styles as the main app, and the SAME dev-mock window.api shim
// so the overlay can be developed in a plain Vite tab (no Electron preload).
// ============================================================================

import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayApp } from "./OverlayApp";
import { installDevMockApi } from "../lib/devMockApi";
import "../styles/tokens.css";
import "../styles/global.css";

// DEV-ONLY: install a mock window.api when running standalone in Vite with no
// preload bridge. Hard no-op in packaged/Electron builds (see devMockApi.ts).
installDevMockApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);
