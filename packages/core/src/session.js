import { usesTextConfidence } from "./duplicate-modes.js";

export const SESSION_VERSION = 2;
export const ANALYSIS_VERSION = 10;

export function analysisFingerprint({ settings, includeTranscript = false, removeNonVerbal = false, textConfidence = 0.9, transcriptionModelId = "base", duplicateMode = "rules" }) {
  const transcriptEnabled = includeTranscript === true;
  const speechAnalysisEnabled = transcriptEnabled || removeNonVerbal === true;
  const normalized = {
    analysisVersion: ANALYSIS_VERSION,
    thresholdDb: Number(settings?.thresholdDb),
    minimumSilence: Number(settings?.minimumSilence),
    keepPause: Number(settings?.keepPause),
    includeTranscript: transcriptEnabled,
    removeNonVerbal: removeNonVerbal === true,
    textConfidence: transcriptEnabled && usesTextConfidence(duplicateMode) ? Number(textConfidence) : null,
    duplicateMode: transcriptEnabled ? duplicateMode : null,
    transcriptionModelId: speechAnalysisEnabled ? transcriptionModelId : null,
  };
  return JSON.stringify(normalized);
}

export function analysisIsCurrent(analysisSignature, input) {
  if (typeof analysisSignature !== 'string') return false;
  const current = analysisFingerprint(input);
  if (analysisSignature === current) return true;
  // Saved v9 decisions remain exportable without running a different editor
  // policy over them. Re-analysis explicitly creates a new v10 signature.
  try {
    const saved = JSON.parse(analysisSignature);
    if (saved.analysisVersion !== 9) return false;
    return JSON.stringify({ ...saved, analysisVersion: ANALYSIS_VERSION }) === current;
  } catch { return false; }
}
