export function secondsToFrames(seconds, frameRate) {
  return Math.round(seconds * frameRate.numerator / frameRate.denominator);
}

function stableSeconds(seconds) {
  return Number(seconds.toFixed(6));
}

export const MAX_TRANSCRIPTION_PAUSE_SECONDS = 0.5;

export function transcriptionSilenceSettings(settings) {
  return {
    thresholdDb: Number(settings?.thresholdDb),
    minimumSilence: Math.min(Number(settings?.minimumSilence), MAX_TRANSCRIPTION_PAUSE_SECONDS),
  };
}

export function buildSpeechRegions(silences, durationSeconds, {
  minimumSpeechSeconds = 0.3,
  transcriptionPaddingSeconds = 0.2,
  mergeSilenceGapSeconds = 0.05,
} = {}) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const normalizedSilences = (silences ?? [])
    .map((silence) => ({
      start: Math.max(0, Math.min(duration, Number(silence?.start))),
      end: Math.max(0, Math.min(duration, Number(silence?.end))),
    }))
    .filter((silence) => Number.isFinite(silence.start)
      && Number.isFinite(silence.end)
      && silence.end > silence.start)
    .sort((first, second) => first.start - second.start || first.end - second.end);
  const mergedSilences = [];
  for (const silence of normalizedSilences) {
    const previous = mergedSilences.at(-1);
    if (previous && silence.start <= previous.end + mergeSilenceGapSeconds) {
      previous.end = Math.max(previous.end, silence.end);
    } else {
      mergedSilences.push({ ...silence });
    }
  }

  const regions = [];
  let cursor = 0;
  const addRegion = (start, end) => {
    if (end - start < minimumSpeechSeconds) return;
    regions.push({
      start: stableSeconds(start),
      end: stableSeconds(end),
      audioStart: stableSeconds(Math.max(0, start - transcriptionPaddingSeconds)),
      audioEnd: stableSeconds(Math.min(duration, end + transcriptionPaddingSeconds)),
    });
  };
  for (const silence of mergedSilences) {
    addRegion(cursor, silence.start);
    cursor = Math.max(cursor, silence.end);
  }
  addRegion(cursor, duration);
  return regions;
}

function keepsFromRemovals(removals, durationFrames) {
  const keeps = [];
  let cursor = 0;
  for (const removal of removals) {
    if (removal.startFrame > cursor) {
      keeps.push({ startFrame: cursor, endFrame: removal.startFrame });
    }
    cursor = Math.max(cursor, removal.endFrame);
  }
  if (cursor < durationFrames) keeps.push({ startFrame: cursor, endFrame: durationFrames });
  return keeps;
}

function mergeRemovals(removals) {
  const merged = [];
  for (const range of [...removals].sort((a, b) => a.startFrame - b.startFrame)) {
    const previous = merged.at(-1);
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function buildSegments(silences, durationSeconds, frameRate, keepPauseSeconds) {
  const durationFrames = secondsToFrames(durationSeconds, frameRate);
  const keepPauseFrames = Math.max(0, secondsToFrames(keepPauseSeconds, frameRate));

  const removals = silences
    .map((silence) => {
      const start = Math.max(0, secondsToFrames(silence.start, frameRate));
      const end = Math.min(durationFrames, secondsToFrames(silence.end, frameRate));
      const atStart = start === 0;
      const atEnd = end === durationFrames;
      const before = atStart ? 0 : atEnd ? keepPauseFrames : Math.floor(keepPauseFrames / 2);
      const after = atEnd ? 0 : atStart ? keepPauseFrames : keepPauseFrames - before;
      return { startFrame: start + before, endFrame: end - after };
    })
    .filter((range) => range.endFrame > range.startFrame)
    .sort((a, b) => a.startFrame - b.startFrame);

  const mergedRemovals = mergeRemovals(removals);
  const keeps = keepsFromRemovals(mergedRemovals, durationFrames);

  return { durationFrames, keeps, removals: mergedRemovals };
}

export function addTextCuts(segments, cuts, frameRate) {
  const textRemovals = cuts
    .map((cut) => ({
      startFrame: Math.max(0, secondsToFrames(cut.start, frameRate)),
      endFrame: Math.min(segments.durationFrames, secondsToFrames(cut.end, frameRate)),
    }))
    .filter((cut) => cut.endFrame > cut.startFrame);
  const removals = mergeRemovals([...segments.removals, ...textRemovals]);
  return {
    durationFrames: segments.durationFrames,
    removals,
    keeps: keepsFromRemovals(removals, segments.durationFrames),
  };
}
