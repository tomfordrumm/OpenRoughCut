// Public entry of @openroughcut/core. Individual modules stay importable as
// "@openroughcut/core/<module>.js" (the desktop renderer imports only the
// browser-safe ones: plan, edit-plan, edit-cleanup, segments, session, …).
export {
  analyze,
  applyDecisions,
  buildPlan,
  createReport,
  DEFAULT_ANALYSIS_SETTINGS,
  exportPlan,
  normalizeAnalysisSettings,
} from "./pipeline.js";
export { assertReviewPacket, assertSameSource, buildReviewPacket, DECISIONS_FORMAT, REVIEW_FORMAT, sourceFingerprint } from "./agent-review.js";
export { DEFAULT_DUPLICATE_MODE, DUPLICATE_MODES, LAST_TAKE_DUPLICATE_MODE } from "./duplicate-modes.js";
export { detectSilences, probeMedia } from "./media.js";
export { isStandardResolution, PROJECT_RESOLUTIONS, resolveProjectResolution } from "./resolution.js";
export { analysisFingerprint, analysisIsCurrent, ANALYSIS_VERSION } from "./session.js";
export { TIMELINE_EXPORTS, timelineExportFor } from "./timeline-export.js";
export { DEFAULT_TRANSCRIPTION_MODEL_ID, TRANSCRIPTION_MODEL_OPTIONS } from "./transcription-models.js";
