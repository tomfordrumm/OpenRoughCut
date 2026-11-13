// Maps desktop requests (renderer IPC payloads) onto the core pipeline.
// Kept free of Electron so tests can run it next to the CLI on the same input.
import * as core from "#core/index.js";
import { assertDuplicateMode } from "#core/duplicate-modes.js";
import { DEFAULT_TRANSCRIPTION_MODEL_ID, isTranscriptionModelId } from "#core/transcription-models.js";

export function assertTranscriptionModelId(value) {
  if (!isTranscriptionModelId(value)) throw new Error("Unknown transcription model.");
  return value;
}

export function assertSettings(settings) {
  const thresholdDb = Number(settings?.thresholdDb);
  const minimumSilence = Number(settings?.minimumSilence);
  const keepPause = Number(settings?.keepPause);
  if (!Number.isFinite(thresholdDb) || thresholdDb > 0 || thresholdDb < -100) throw new Error("Threshold must be between -100 and 0 dB.");
  if (!Number.isFinite(minimumSilence) || minimumSilence <= 0) throw new Error("Minimum silence must be greater than zero.");
  if (!Number.isFinite(keepPause) || keepPause < 0 || keepPause >= minimumSilence) throw new Error("Pause to keep must be non-negative and shorter than minimum silence.");
  return { thresholdDb, minimumSilence, keepPause };
}

// The desktop slider allows a narrower confidence range than the core (0–1).
export function assertAnalysisOptions(request) {
  const includeTranscript = request?.includeTranscript === true;
  const removeNonVerbal = request?.removeNonVerbal === true;
  const textConfidence = Number(request?.textConfidence ?? 0.9);
  if (!Number.isFinite(textConfidence) || textConfidence < 0.5 || textConfidence > 0.99) throw new Error("Text confidence must be between 0.5 and 0.99.");
  const transcriptionModelId = assertTranscriptionModelId(request?.transcriptionModelId ?? DEFAULT_TRANSCRIPTION_MODEL_ID);
  const duplicateMode = assertDuplicateMode(request?.duplicateMode);
  return { includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId, duplicateMode };
}

/** Desktop analysis request → core analysis settings. */
export function coreAnalysisSettings(request) {
  const { thresholdDb, minimumSilence, keepPause } = assertSettings(request?.settings);
  const { includeTranscript, removeNonVerbal, textConfidence, duplicateMode } = assertAnalysisOptions(request);
  return { thresholdDb, minimumSilence, keepPause, transcribe: includeTranscript, removeNonVerbal, duplicateMode, textConfidence };
}

function toolsFrom(runtime) {
  return { ffmpeg: runtime?.ffmpeg?.command, ffprobe: runtime?.ffprobe?.command, whisper: runtime?.whisper?.command };
}

/**
 * Run the core analysis for an open source and return what the renderer keeps
 * in its session (no raw Whisper tokens).
 */
export async function analyzeSource({ sourcePath, media, request, runtime, signal, onProgress, pipeline = core, dependencies }) {
  const analysis = await pipeline.analyze(sourcePath, coreAnalysisSettings(request), {
    signal,
    media,
    onProgress,
    dependencies,
    tools: toolsFrom(runtime),
    models: { whisper: runtime?.model?.path, vad: runtime?.vadModel?.path },
  });
  const { silences, silenceRemovals, automaticRemovals, transcript, textCandidates, textEditSummary } = analysis;
  return { media: analysis.media, silences, silenceRemovals, automaticRemovals, transcript, textCandidates, textEditSummary };
}

/**
 * Build the final plan from a saved analysis plus manual overrides and export
 * it. `analysis` is the sanitized renderer analysis; overrides are in seconds.
 */
export async function exportSource({ sourcePath, media, analysis, manualOverrides = [], keepPause, exportFormat, projectResolution, outputPath, runtime, signal, onProgress, pipeline = core, dependencies }) {
  const plan = pipeline.buildPlan({ ...analysis, media, settings: { keepPause } }, manualOverrides);
  const result = await pipeline.exportPlan(plan, {
    format: exportFormat, inputPath: sourcePath, outputPath, media, projectResolution, signal, onProgress, dependencies, tools: toolsFrom(runtime),
  });
  return { plan, result };
}
