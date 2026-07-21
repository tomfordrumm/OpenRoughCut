export function secondsToFrames(seconds, frameRate) {
  return Math.round(seconds * frameRate.numerator / frameRate.denominator);
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
