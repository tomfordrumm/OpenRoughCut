import { analysisFingerprint } from "../../src/session.js";
import { TRANSCRIPTION_MODEL_OPTIONS } from "../../src/transcription-models.js";

const settings = { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18 };
const media = {
  width: 3840,
  height: 2160,
  duration: 842.4,
  frameRate: { numerator: 30000, denominator: 1001 },
  audioChannels: 2,
};
const automaticRemovals = [
  { startFrame: 2200, endFrame: 2950 },
  { startFrame: 8760, endFrame: 10200 },
  { startFrame: 18300, endFrame: 19900 },
];

const readyRuntime = {
  coreReady: true,
  transcriptionReady: true,
  canInstall: false,
  installBytes: 0,
  ffmpeg: { ready: true, source: "bundled" },
  ffprobe: { ready: true, source: "bundled" },
  whisper: { ready: true, source: "bundled" },
  selectedModelId: "base",
  models: TRANSCRIPTION_MODEL_OPTIONS.map((model) => ({ ...model, ready: model.id === "base", source: model.id === "base" ? "downloaded" : null })),
  model: { ...TRANSCRIPTION_MODEL_OPTIONS[0], ready: true, source: "downloaded" },
  vadModel: { ready: true, source: "downloaded" },
};

export function createMockBridge(mode) {
  const setupRuntime = {
    ...readyRuntime,
    coreReady: false,
    transcriptionReady: false,
    canInstall: true,
    installBytes: 204_000_000,
    ffmpeg: { ready: false, source: null },
    ffprobe: { ready: false, source: null },
    whisper: { ready: true, source: "bundled" },
    models: TRANSCRIPTION_MODEL_OPTIONS.map((model) => ({ ...model, ready: false, source: null })),
    model: { ...TRANSCRIPTION_MODEL_OPTIONS[0], ready: false, source: null },
    vadModel: { ready: false, source: null },
  };
  const recovered = mode === "workspace" ? {
    sourceId: "mock-source",
    name: "interview_master_4k.mov",
    media,
    settings,
    projectResolution: "source",
    exportFormat: "final-cut",
    includeTranscript: false,
    removeNonVerbal: true,
    textConfidence: 0.9,
    analysisSignature: analysisFingerprint({ settings, includeTranscript: false, removeNonVerbal: true, textConfidence: 0.9 }),
    analysis: { silences: [], silenceRemovals: automaticRemovals, automaticRemovals, textCandidates: [], transcript: null },
    manualOverrides: [{ id: "mock-keep", action: "keep", start: 98, end: 101, originKey: null }],
    sessionPath: "/Users/demo/interview.roughcut",
  } : null;
  const noOperation = () => Promise.resolve({ cancelled: false });
  return {
    runtimeStatus: async () => mode === "setup" ? setupRuntime : readyRuntime,
    installDependencies: async () => readyRuntime,
    cancelOperation: noOperation,
    showLogs: async () => ({ path: "/tmp/OpenRoughCut/logs/openroughcut.log" }),
    chooseVideo: async () => recovered,
    preparePreview: async () => ({ previewUrl: null, cached: true }),
    listProxies: async () => ({ cacheLocation: "/Users/demo/Library/Caches/OpenRoughCut", totalSize: 0, proxies: [] }),
    deleteProxies: async () => ({ deletedIds: [] }),
    analyze: async () => ({ media, silences: [], silenceRemovals: automaticRemovals, automaticRemovals, textCandidates: [], transcript: null }),
    saveSession: async () => ({ path: "/Users/demo/interview.roughcut", savedAt: new Date().toISOString() }),
    autosaveSession: async () => ({ path: "/Users/demo/recovery-session.json", savedAt: new Date().toISOString() }),
    closeSession: async () => ({ closed: true }),
    recoverSession: async () => recovered,
    loadSession: async () => recovered,
    finishSessionFlush: () => {},
    onSessionFlushRequest: () => () => {},
    exportProject: async () => ({ label: "FCPXML", keptRanges: 4 }),
    onProgress: () => () => {},
  };
}
