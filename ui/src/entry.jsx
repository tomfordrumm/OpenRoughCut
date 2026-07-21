import React from "react";
import { createRoot } from "react-dom/client";
import App from "./main.jsx";
import { createMockBridge } from "./mock-bridge.js";

if (!window.roughcut && import.meta.env.DEV) {
  const mockMode = new URLSearchParams(window.location.search).get("mock");
  if (["empty", "workspace", "setup"].includes(mockMode)) window.roughcut = createMockBridge(mockMode);
}

const root = createRoot(document.getElementById("root"));
if (!window.roughcut) {
  root.render(<main className="app-shell boot-shell"><section className="startup-error"><strong>OpenRoughCut could not start safely.</strong><span>The secure desktop bridge is unavailable. Reinstall the app or contact support.</span></section></main>);
} else {
  root.render(<App/>);
}
