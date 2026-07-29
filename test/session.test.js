import test from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_VERSION, analysisFingerprint, analysisIsCurrent, SESSION_VERSION } from "../src/session.js";

const settings = { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18 };

test("analysis fingerprints change only when analysis inputs change", () => {
  const first = analysisFingerprint({ settings, includeTranscript: false, textConfidence: 0.9, transcriptionModelId: "base" });
  assert.equal(first, analysisFingerprint({ settings: { ...settings }, includeTranscript: false, textConfidence: 0.9, transcriptionModelId: "small" }));
  assert.equal(first, analysisFingerprint({ settings, includeTranscript: false, textConfidence: 0.72, transcriptionModelId: "large-v3-turbo" }));
  assert.notEqual(first, analysisFingerprint({ settings: { ...settings, thresholdDb: -40 }, includeTranscript: false, textConfidence: 0.9 }));
  assert.notEqual(first, analysisFingerprint({ settings, includeTranscript: true, textConfidence: 0.9 }));
  assert.notEqual(first, analysisFingerprint({ settings, removeNonVerbal: true }));
  assert.notEqual(
    analysisFingerprint({ settings, removeNonVerbal: true, transcriptionModelId: "base" }),
    analysisFingerprint({ settings, removeNonVerbal: true, transcriptionModelId: "small" }),
  );
  assert.notEqual(
    analysisFingerprint({ settings, includeTranscript: true, transcriptionModelId: "base" }),
    analysisFingerprint({ settings, includeTranscript: true, transcriptionModelId: "small" }),
  );
});

test("analysis current state requires an exact saved signature", () => {
  const input = { settings, includeTranscript: true, textConfidence: 0.92 };
  assert.equal(analysisIsCurrent(null, input), false);
  assert.equal(analysisIsCurrent(JSON.stringify({ ...settings, includeTranscript: true, textConfidence: 0.92 }), input), false);
  assert.equal(analysisIsCurrent(analysisFingerprint(input), input), true);
  assert.equal(SESSION_VERSION, 2);
  assert.equal(ANALYSIS_VERSION, 5);
});
