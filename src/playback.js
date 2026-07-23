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
