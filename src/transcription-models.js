export const DEFAULT_TRANSCRIPTION_MODEL_ID = "base";

export const TRANSCRIPTION_MODEL_OPTIONS = [
  {
    id: "base",
    label: "Base",
    detail: "Fastest · 142 MB",
    description: "For older or lower-power computers.",
  },
  {
    id: "small",
    label: "Small",
    detail: "Balanced · 465 MB",
    description: "Better multilingual accuracy with moderate resource use.",
  },
  {
    id: "large-v3-turbo",
    label: "Large Turbo",
    detail: "Best accuracy · 1.5 GB",
    description: "For modern computers with at least 8 GB of available memory.",
  },
];

export function isTranscriptionModelId(value) {
  return TRANSCRIPTION_MODEL_OPTIONS.some((option) => option.id === value);
}

export function normalizeTranscriptionModelId(value) {
  return isTranscriptionModelId(value) ? value : DEFAULT_TRANSCRIPTION_MODEL_ID;
}
