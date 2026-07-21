import test from "node:test";
import assert from "node:assert/strict";
import { applyManualOverrides, removalAtFrame } from "../src/edit-plan.js";

test("manual keep punches a hole through an automatic removal", () => {
  const result = applyManualOverrides(
    [{ startFrame: 10, endFrame: 90 }],
    [{ action: "keep", startFrame: 30, endFrame: 50 }],
    100,
  );
  assert.deepEqual(result.removals, [
    { startFrame: 10, endFrame: 30 },
    { startFrame: 50, endFrame: 90 },
  ]);
});

test("manual remove adds a source-time removal", () => {
  const result = applyManualOverrides(
    [{ startFrame: 10, endFrame: 20 }],
    [{ action: "remove", startFrame: 60, endFrame: 80 }],
    100,
  );
  assert.deepEqual(result.keeps, [
    { startFrame: 0, endFrame: 10 },
    { startFrame: 20, endFrame: 60 },
    { startFrame: 80, endFrame: 100 },
  ]);
});

test("the latest overlapping manual override wins", () => {
  const result = applyManualOverrides([], [
    { action: "remove", startFrame: 10, endFrame: 80 },
    { action: "keep", startFrame: 30, endFrame: 60 },
    { action: "remove", startFrame: 40, endFrame: 50 },
  ], 100);
  assert.deepEqual(result.removals, [
    { startFrame: 10, endFrame: 30 },
    { startFrame: 40, endFrame: 50 },
    { startFrame: 60, endFrame: 80 },
  ]);
});

test("adjacent and overlapping removals merge without zero-length keeps", () => {
  const result = applyManualOverrides([
    { startFrame: 10, endFrame: 20 },
    { startFrame: 20, endFrame: 30 },
    { startFrame: 25, endFrame: 40 },
  ], [], 100);
  assert.deepEqual(result.removals, [{ startFrame: 10, endFrame: 40 }]);
  assert.deepEqual(result.keeps, [{ startFrame: 0, endFrame: 10 }, { startFrame: 40, endFrame: 100 }]);
});

test("ranges are clamped, reversed, and rounded to source frames", () => {
  const result = applyManualOverrides([], [
    { action: "remove", startFrame: 91.8, endFrame: -20.2 },
  ], 100);
  assert.deepEqual(result.removals, [{ startFrame: 0, endFrame: 92 }]);
});

test("a whole-file removal is represented explicitly for callers to reject", () => {
  const result = applyManualOverrides([], [{ action: "remove", startFrame: 0, endFrame: 100 }], 100);
  assert.deepEqual(result.removals, [{ startFrame: 0, endFrame: 100 }]);
  assert.deepEqual(result.keeps, []);
});

test("overlapping automatic ranges and boundary-adjacent overrides sweep correctly", () => {
  const result = applyManualOverrides([
    { startFrame: 10, endFrame: 50 },
    { startFrame: 30, endFrame: 70 },
  ], [
    { action: "keep", startFrame: 20, endFrame: 40 },
    { action: "remove", startFrame: 40, endFrame: 60 },
    { action: "keep", startFrame: 50, endFrame: 80 },
  ], 100);
  assert.deepEqual(result.removals, [
    { startFrame: 10, endFrame: 20 },
    { startFrame: 40, endFrame: 50 },
  ]);
});

test("large edit plans remain practical", () => {
  const automatic = Array.from({ length: 20_000 }, (_, index) => ({
    startFrame: index * 10,
    endFrame: index * 10 + 4,
  }));
  const overrides = Array.from({ length: 2_000 }, (_, index) => ({
    action: index % 2 ? "keep" : "remove",
    startFrame: index * 100 + 2,
    endFrame: index * 100 + 6,
  }));
  const result = applyManualOverrides(automatic, overrides, 200_000);
  assert.ok(result.removals.length > 0);
  assert.equal(result.durationFrames, 200_000);
});

test("playback locates a removal with binary search boundaries", () => {
  const removals = [{ startFrame: 10, endFrame: 20 }, { startFrame: 40, endFrame: 50 }];
  assert.equal(removalAtFrame(removals, 9), null);
  assert.deepEqual(removalAtFrame(removals, 10), removals[0]);
  assert.deepEqual(removalAtFrame(removals, 49), removals[1]);
  assert.equal(removalAtFrame(removals, 50), null);
});
