import { applyManualOverrides } from './edit-plan.js';
import { savedWordTiming } from './word-timing.js';
import { buildSegments } from './segments.js';

function speechEvidence({ transcript, textCandidates = [], manualOverrides = [], frameRate, reviewPolicy }) {
  const fps = frameRate.numerator / frameRate.denominator, frame = x => Math.round(x * fps);
  const segments = transcript?.segments ?? [];
  const speechCuts = [...manualOverrides.filter(c => c.action === 'remove'), ...textCandidates.filter(c => c.applied)].map(c => ({ startFrame: frame(c.start), endFrame: frame(c.end) }));
  const keeps = manualOverrides.filter(c => c.action === 'keep').map(c => ({ startFrame: frame(c.start), endFrame: frame(c.end) }));
  const groupedPolicy = reviewPolicy === 'last-usable-take-v1' || textCandidates.some(c => c.groupId);
  const measuredSegments = groupedPolicy ? segments.map((s, sourceIndex) => ({ ...s, sourceIndex, words: savedWordTiming(s) })) : [];
  const deletedSpeech = segments.filter(s => speechCuts.some(c => c.startFrame <= frame(s.start) + 1 && c.endFrame >= frame(s.end) - 1) && !keeps.some(k => k.startFrame < frame(s.end) && k.endFrame > frame(s.start)));
  const deletedSources = new Set(segments.map((s, i) => deletedSpeech.includes(s) ? i : -1));
  const appliedGroups = textCandidates.filter(c => c.groupId && c.applied);
  const measuredWords = measuredSegments.flatMap(s => deletedSources.has(s.sourceIndex) ? [] : s.words.filter(w => keeps.some(k => k.startFrame < w.end * fps && k.endFrame > w.start * fps) || !appliedGroups.some(c => c.start < s.end && c.end > s.start && w.start < c.end && w.end > c.start)));
  const protectedSpeech = [...measuredWords, ...measuredSegments.filter(s => !s.words.length && !deletedSources.has(s.sourceIndex)).map(s => ({ start: s.start, end: s.end }))];
  return { fps, frame, segments, speechCuts, keeps, groupedPolicy, measuredSegments, deletedSpeech, measuredWords, protectedSpeech };
}

// A one-sample click must not reset the minimum-silence timer. Merge measured
// quiet before applying that threshold, while protecting even sub-frame words.
function refineQuietPlan(plan, options) {
  const { measuredSilences = [], minimumSilence = .7, keepPause = .18, frameRate, manualOverrides = [] } = options;
  const evidence = speechEvidence(options);
  if (!evidence.groupedPolicy || !measuredSilences.length) return { ...plan, quietBridges: 0 };
  const { fps, protectedSpeech } = evidence, merged = [];
  let quietBridges = 0;
  for (const range of [...measuredSilences].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1), gap = last ? range.start - last.end : Infinity;
    if (last && gap <= 1 / fps && !protectedSpeech.some(w => w.start < range.start && w.end > last.end)) {
      if (gap > 0) quietBridges++;
      last.end = Math.max(last.end, range.end);
    } else merged.push({ start: range.start, end: range.end });
  }
  const quiet = buildSegments(merged.filter(r => r.end - r.start >= minimumSilence), plan.durationFrames / fps, frameRate, keepPause);
  const wordKeeps = protectedSpeech.map(w => ({ action: 'keep', startFrame: Math.floor((w.start - .03) * fps), endFrame: Math.ceil((w.end + .03) * fps) }));
  const safeQuiet = applyManualOverrides(quiet.removals, wordKeeps, plan.durationFrames);
  const overrides = manualOverrides.map(c => ({ action: c.action, startFrame: Math.round(c.start * fps), endFrame: Math.round(c.end * fps) }));
  return { ...applyManualOverrides([...plan.removals, ...safeQuiet.removals], overrides, plan.durationFrames), quietBridges };
}

// Two short original pauses can become one long pause after a take is removed.
// Extend only into measured quiet and leave handles beside retained words.
function trimRemovedSpeechPauses(plan, options) {
  const { manualOverrides = [], measuredSilences = [], keepPause = .18 } = options;
  const evidence = speechEvidence(options);
  if (!evidence.groupedPolicy || !measuredSilences.length) return plan;
  const { fps, frame, speechCuts: cuts } = evidence;
  const protectedSpeech = evidence.protectedSpeech.map(w => ({ startFrame: w.start * fps, endFrame: w.end * fps }));
  const quiet = measuredSilences.map(s => ({ startFrame: frame(s.start), endFrame: frame(s.end) }));
  const handle = Math.ceil(keepPause * fps / 2), extensions = [];
  for (const cut of cuts) {
    let startFrame = cut.startFrame, endFrame = cut.endFrame;
    for (const silence of quiet) {
      if (silence.endFrame === cut.startFrame) startFrame = Math.min(startFrame, Math.min(cut.startFrame, silence.startFrame + handle));
      if (silence.startFrame === cut.endFrame) endFrame = Math.max(endFrame, Math.max(cut.endFrame, silence.endFrame - handle));
    }
    for (const speech of protectedSpeech) {
      if (speech.startFrame < cut.startFrame && speech.endFrame > startFrame) startFrame = Math.min(cut.startFrame, Math.max(startFrame, Math.ceil(speech.endFrame)));
      if (speech.endFrame > cut.endFrame && speech.startFrame < endFrame) endFrame = Math.max(cut.endFrame, Math.min(endFrame, Math.floor(speech.startFrame)));
    }
    if (startFrame < cut.startFrame || endFrame > cut.endFrame) extensions.push({ startFrame, endFrame });
  }
  const overrides = manualOverrides.map(c => ({ action: c.action, startFrame: frame(c.start), endFrame: frame(c.end) }));
  return { ...applyManualOverrides([...plan.removals, ...extensions], overrides, plan.durationFrames), cleanedHandles: plan.cleanedHandles, trimmedPauseEdges: extensions };
}

// Clean only pause handles beside explicitly removed speech. Short retained speech stays.
export function cleanSpeechCutHandles(plan, options = {}) {
  const { keepPause = .18 } = options;
  const { fps, frame: toFrames, segments, speechCuts, keeps, groupedPolicy, measuredSegments, deletedSpeech, measuredWords } = speechEvidence(options);
  if (!segments.length) return { ...plan, cleanedHandles: [] };
  const cleanedHandles = plan.keeps.filter(r=> {
    if (keeps.some(k=>k.startFrame<r.endFrame && k.endFrame>r.startFrame)) return false;
    if (measuredWords.some(w => w.start * fps < r.endFrame && w.end * fps > r.startFrame)) return false;
    const touching = measuredSegments.filter(s => s.start * fps < r.endFrame && s.end * fps > r.startFrame);
    const besideCut = speechCuts.some(c => Math.abs(c.endFrame-r.startFrame)<=1 || Math.abs(c.startFrame-r.endFrame)<=1);
    // Several partial cuts inside one transcript block can strand a word-free
    // clip. Use measured words, including words shorter than a video frame.
    if (besideCut && touching.length && touching.every(s => s.words.length)) return true;
    const betweenDeletedTakes = deletedSpeech.some(s=>Math.abs(toFrames(s.end)-r.startFrame)<=1)
      && deletedSpeech.some(s=>Math.abs(toFrames(s.start)-r.endFrame)<=1);
    const limit = betweenDeletedTakes ? groupedPolicy ? Number.POSITIVE_INFINITY : toFrames(1) : Math.max(2,toFrames(keepPause*2));
    if (r.endFrame-r.startFrame>limit) return false;
    if (!deletedSpeech.some(s=>toFrames(s.start)<=r.endFrame+toFrames(keepPause) && toFrames(s.end)>=r.startFrame-toFrames(keepPause))) return false;
    return !segments.some(s=>!deletedSpeech.includes(s) && toFrames(s.start)<r.endFrame-1 && toFrames(s.end)>r.startFrame+1);
  });
  const merged = applyManualOverrides([...plan.removals,...cleanedHandles],[],plan.durationFrames);
  return { ...merged, cleanedHandles };
}
export function buildReviewedPlan(automaticRemovals, overrides, durationFrames, options) {
  const fps=options.frameRate.numerator/options.frameRate.denominator;
  const plan=applyManualOverrides(automaticRemovals, overrides.map(r=>({...r,startFrame:Math.round(r.start*fps),endFrame:Math.round(r.end*fps)})),durationFrames);
  const evidenceOptions = { ...options, manualOverrides: overrides };
  const refined = refineQuietPlan(plan, evidenceOptions);
  const cleaned = cleanSpeechCutHandles(refined, evidenceOptions);
  return { ...trimRemovedSpeechPauses(cleaned, evidenceOptions), quietBridges: refined.quietBridges };
}
