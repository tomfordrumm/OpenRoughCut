export function previewKeyframeOptions(frameRate) {
  const framesPerSecond = frameRate.numerator / frameRate.denominator;
  const maximumGopFrames = Math.max(1, Math.round(framesPerSecond));
  return [
    "-g", String(maximumGopFrames),
    "-force_key_frames", "expr:gte(t,n_forced*1)",
  ];
}

export function playbackFrameAtTime(mediaTime, frameRate) {
  const framesPerSecond = frameRate.numerator / frameRate.denominator;
  return Math.floor(mediaTime * framesPerSecond + 1e-4);
}

export function seekTimeAfterRemoval(endFrame, frameRate, duration) {
  const frameDuration = frameRate.denominator / frameRate.numerator;
  // Seek just inside the first retained frame so floating-point rounding cannot
  // place Chromium back in the removal and start a repeated-seek loop.
  return Math.min(duration, (endFrame + 0.05) * frameDuration);
}

/**
 * Removals as playback jumps in seconds: reaching `start`, the preview should
 * continue at `end` (just inside the next kept frame).
 */
export function playbackJumps(removals, frameRate, duration) {
  const frameDuration = frameRate.denominator / frameRate.numerator;
  return removals
    .map((removal) => ({ start: removal.startFrame * frameDuration, end: seekTimeAfterRemoval(removal.endFrame, frameRate, duration) }))
    .filter((jump) => jump.end > jump.start)
    .sort((a, b) => a.start - b.start);
}

/** The first jump not yet passed at `time`: ahead of it, or containing it. */
export function upcomingJump(jumps, time) {
  let low = 0, high = jumps.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (jumps[middle].end <= time + 1e-3) low = middle + 1; else high = middle;
  }
  return jumps[low] ?? null;
}
