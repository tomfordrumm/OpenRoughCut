import test from "node:test";
import assert from "node:assert/strict";
import { playbackFrameAtTime, playbackJumps, previewKeyframeOptions, seekTimeAfterRemoval, upcomingJump } from "../src/playback.js";

const ntsc = { numerator: 30_000, denominator: 1_001 };

test("preview encoding limits keyframe distance to about one second", () => {
  assert.deepEqual(previewKeyframeOptions(ntsc), [
    "-g", "30",
    "-force_key_frames", "expr:gte(t,n_forced*1)",
  ]);
});

test("playback frame conversion tolerates floating-point drift at a cut boundary", () => {
  const exactBoundary = 1_001 / 30_000 * 300;
  assert.equal(playbackFrameAtTime(exactBoundary - 1e-8, ntsc), 300);
});

test("cut seeks land inside the first retained frame without skipping it", () => {
  const target = seekTimeAfterRemoval(300, ntsc, 60);
  assert.ok(target > 1_001 / 30_000 * 300);
  assert.ok(target < 1_001 / 30_000 * 301);
  assert.equal(playbackFrameAtTime(target, ntsc), 300);
});

test("a cut ending at media duration does not seek past the end", () => {
  assert.equal(seekTimeAfterRemoval(1_800, { numerator: 30, denominator: 1 }, 60), 60);
});

test("the preview knows which cut comes next, so the second player can wait there", () => {
  const rate = { numerator: 30, denominator: 1 };
  const jumps = playbackJumps([{ startFrame: 300, endFrame: 360 }, { startFrame: 30, endFrame: 60 }], rate, 20);
  assert.deepEqual(jumps.map((j) => [j.start, Number(j.end.toFixed(4))]), [[1, 2.0017], [10, 12.0017]]);
  assert.equal(upcomingJump(jumps, 0).start, 1);
  assert.equal(upcomingJump(jumps, 1.5).start, 1, "inside a cut it is still the next jump");
  assert.equal(upcomingJump(jumps, 5).start, 10);
  assert.equal(upcomingJump(jumps, 13), null);
});
