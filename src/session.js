export const SESSION_VERSION = 2;
export const ANALYSIS_VERSION = 5;

export function analysisFingerprint({ settings, includeTranscript = false, removeNonVerbal = false, textConfidence = 0.9, transcriptionModelId = "base" }) {
  const transcriptEnabled = includeTranscript === true;
  const speechAnalysisEnabled = transcriptEnabled || removeNonVerbal === true;
  const normalized = {
    analysisVersion: ANALYSIS_VERSION,
    thresholdDb: Number(settings?.thresholdDb),
    minimumSilence: Number(settings?.minimumSilence),
    keepPause: Number(settings?.keepPause),
    includeTranscript: transcriptEnabled,
    removeNonVerbal: removeNonVerbal === true,
    textConfidence: transcriptEnabled ? Number(textConfidence) : null,
    transcriptionModelId: speechAnalysisEnabled ? transcriptionModelId : null,
  };
  return JSON.stringify(normalized);
}

export function analysisIsCurrent(analysisSignature, input) {
  return typeof analysisSignature === "string" && analysisSignature === analysisFingerprint(input);
}
