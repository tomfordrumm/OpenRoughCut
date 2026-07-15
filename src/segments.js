export function secondsToFrames(seconds, frameRate) {
  return Math.round(seconds * frameRate.numerator / frameRate.denominator);
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

  const mergedRemovals = [];
  for (const range of removals) {
    const previous = mergedRemovals.at(-1);
    if (previous && range.startFrame <= previous.endFrame) {
      previous.endFrame = Math.max(previous.endFrame, range.endFrame);
    } else {
      mergedRemovals.push({ ...range });
    }
  }

  const keeps = [];
  let cursor = 0;
  for (const removal of mergedRemovals) {
    if (removal.startFrame > cursor) {
      keeps.push({ startFrame: cursor, endFrame: removal.startFrame });
    }
    cursor = Math.max(cursor, removal.endFrame);
  }
  if (cursor < durationFrames) keeps.push({ startFrame: cursor, endFrame: durationFrames });

  return { durationFrames, keeps, removals: mergedRemovals };
}
