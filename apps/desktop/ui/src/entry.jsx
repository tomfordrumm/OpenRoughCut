import React from "react";
import { createRoot } from "react-dom/client";
import App from "./main.jsx";
import { createMockBridge } from "./mock-bridge.js";

if (!window.roughcut && import.meta.env.DEV) {
  const mockMode = new URLSearchParams(window.location.search).get("mock");
  if (["empty", "workspace", "setup"].includes(mockMode)) window.roughcut = createMockBridge(mockMode);
}

if (!window.roughcut && import.meta.env.DEV && new URLSearchParams(window.location.search).get("mock") === "review") {
  const fixture = await fetch('/@fs/Users/tomfordrumm/Documents/VideoEditor/.roughcut-tmp/review-demo.json').then(r => r.json());
  window.roughcut = { ...createMockBridge("workspace"), recoverSession: async () => ({ ...fixture, ...JSON.parse(localStorage.getItem("roughcut.reviewDemo") ?? "{}") }), loadSession: async () => fixture,
    autosaveSession: async payload => { localStorage.setItem("roughcut.reviewDemo", JSON.stringify(payload)); return {savedAt:new Date().toISOString()}; },
    exportProject: async () => { throw new Error("В браузерном прототипе сохраните проект через Save project и откройте его в приложении для экспорта."); },
    preparePreview: async () => ({ previewUrl: '/@fs/Users/tomfordrumm/Documents/VideoEditor/.roughcut-tmp/review-demo.mp4' }),
    waveform: async () => { const bytes = new Uint8Array(await fetch('/@fs/Users/tomfordrumm/Documents/VideoEditor/.roughcut-tmp/review-demo.peaks').then(r => r.arrayBuffer())); return { peaksPerSecond: bytes[0], peaks: bytes.subarray(1) }; },
    saveSession: async payload => { const blob = new Blob([JSON.stringify({ ...fixture, ...payload, sourcePath: fixture.sourcePath, version: fixture.version }, null, 2)], {type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='transcript-review.roughcut'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); return {path:'transcript-review.roughcut',savedAt:new Date().toISOString()}; }
  };
}

const root = createRoot(document.getElementById("root"));
if (!window.roughcut) {
  root.render(<main className="app-shell boot-shell"><section className="startup-error"><strong>OpenRoughCut could not start safely.</strong><span>The secure desktop bridge is unavailable. Reinstall the app or contact support.</span></section></main>);
} else {
  root.render(<App/>);
}
