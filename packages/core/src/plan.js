// The final edit plan from an analysis plus the user's keep/remove overrides.
// Browser-safe (no Node imports): the desktop renderer builds its live preview
// plan with this same function that the CLI and the desktop export use.
import { buildReviewedPlan } from "./edit-cleanup.js";
import { secondsToFrames } from "./segments.js";

/**
 * @param analysis  { media, settings: { keepPause }, automaticRemovals, transcript, textCandidates, textEditSummary }
 * @param manualOverrides  [{ action: "keep" | "remove", start, end }] in source seconds; later entries win.
 * @returns { durationFrames, removals, keeps, ... } in source frames.
 */
export function buildPlan(analysis, manualOverrides = []) {
  const { media } = analysis;
  if (!media?.frameRate || !Number.isFinite(media.duration)) throw new Error("The analysis has no media timing.");
  const durationFrames = secondsToFrames(media.duration, media.frameRate);
  return buildReviewedPlan(analysis.automaticRemovals ?? [], manualOverrides, durationFrames, {
    transcript: analysis.transcript ?? null,
    textCandidates: analysis.textCandidates ?? [],
    reviewPolicy: analysis.textEditSummary?.reviewPolicy,
    frameRate: media.frameRate,
    keepPause: analysis.settings?.keepPause,
  });
}
