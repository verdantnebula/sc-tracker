import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installDevMockApi } from "./lib/devMockApi";
import "./styles/tokens.css";
import "./styles/global.css";

// DEV-ONLY: install a mock window.api when running standalone in Vite with no
// preload bridge. Hard no-op in packaged/Electron builds (see devMockApi.ts).
installDevMockApi();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
