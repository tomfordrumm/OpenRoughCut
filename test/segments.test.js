import test from "node:test";
import assert from "node:assert/strict";
import { addTextCuts, buildSegments } from "../src/segments.js";

const fps25 = { numerator: 25, denominator: 1 };

test("shortens a middle silence and preserves half the pause on each side", () => {
  const result = buildSegments([{ start: 2, end: 4 }], 10, fps25, 0.2);
  assert.deepEqual(result.removals, [{ startFrame: 52, endFrame: 97 }]);
  assert.deepEqual(result.keeps, [
    { startFrame: 0, endFrame: 52 },
    { startFrame: 97, endFrame: 250 },
  ]);
});

test("preserves the pause beside speech at the start and end", () => {
  const result = buildSegments([
    { start: 0, end: 2 },
    { start: 8, end: 10 },
  ], 10, fps25, 0.2);
  assert.deepEqual(result.removals, [
    { startFrame: 0, endFrame: 45 },
    { startFrame: 205, endFrame: 250 },
  ]);
  assert.deepEqual(result.keeps, [{ startFrame: 45, endFrame: 205 }]);
});

test("does not create a cut when a requested pause fills the detected range", () => {
  const result = buildSegments([{ start: 2, end: 2.1 }], 5, fps25, 0.18);
  assert.deepEqual(result.removals, []);
  assert.deepEqual(result.keeps, [{ startFrame: 0, endFrame: 125 }]);
});

test("merges transcript cuts with silence cuts before rebuilding keep segments", () => {
  const silenceSegments = buildSegments([{ start: 4, end: 6 }], 10, fps25, 0.2);
  const result = addTextCuts(silenceSegments, [{ start: 1, end: 5 }], fps25);
  assert.deepEqual(result.removals, [{ startFrame: 25, endFrame: 147 }]);
  assert.deepEqual(result.keeps, [
    { startFrame: 0, endFrame: 25 },
    { startFrame: 147, endFrame: 250 },
  ]);
});
