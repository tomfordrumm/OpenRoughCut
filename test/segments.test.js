import test from "node:test";
import assert from "node:assert/strict";
import { addTextCuts, buildSegments, buildSpeechRegions, transcriptionSilenceSettings } from "../src/segments.js";

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

test("builds padded speech regions from the inverse of detected silence", () => {
  const regions = buildSpeechRegions([
    { start: 0, end: 0.7 },
    { start: 1.7, end: 7.9 },
    { start: 7.91, end: 8.9 },
    { start: 12, end: 16.7 },
  ], 20);
  assert.deepEqual(regions, [
    { start: 0.7, end: 1.7, audioStart: 0.5, audioEnd: 1.9 },
    { start: 8.9, end: 12, audioStart: 8.7, audioEnd: 12.2 },
    { start: 16.7, end: 20, audioStart: 16.5, audioEnd: 20 },
  ]);
});

test("drops tiny non-speech spikes between adjacent silence ranges", () => {
  const regions = buildSpeechRegions([
    { start: 0, end: 5 },
    { start: 5.2, end: 10 },
  ], 10);
  assert.deepEqual(regions, []);
});

test("keeps very short islands available for non-word sound classification", () => {
  const regions = buildSpeechRegions([
    { start: 0, end: 5 },
    { start: 5.08, end: 10 },
  ], 10, { minimumSpeechSeconds: 0.02 });
  assert.deepEqual(regions, [{ start: 5, end: 5.08, audioStart: 4.8, audioEnd: 5.28 }]);
});

test("uses shorter pauses for take boundaries without changing silence editing", () => {
  const settings = { thresholdDb: -27, minimumSilence: 0.7, keepPause: 0.18 };
  assert.deepEqual(transcriptionSilenceSettings(settings), { thresholdDb: -27, minimumSilence: 0.5 });
  assert.equal(settings.minimumSilence, 0.7);
  assert.equal(transcriptionSilenceSettings({ ...settings, minimumSilence: 0.35 }).minimumSilence, 0.35);
});
