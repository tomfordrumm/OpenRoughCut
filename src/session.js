export const SESSION_VERSION = 2;

export function analysisFingerprint({ settings, includeTranscript = false, textConfidence = 0.9 }) {
  const transcriptEnabled = includeTranscript === true;
  const normalized = {
    thresholdDb: Number(settings?.thresholdDb),
    minimumSilence: Number(settings?.minimumSilence),
    keepPause: Number(settings?.keepPause),
    includeTranscript: transcriptEnabled,
    textConfidence: transcriptEnabled ? Number(textConfidence) : null,
  };
  return JSON.stringify(normalized);
}

export function analysisIsCurrent(analysisSignature, input) {
  return typeof analysisSignature === "string" && analysisSignature === analysisFingerprint(input);
}
