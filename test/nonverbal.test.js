import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSoundIslands,
  detectNonVerbalSounds,
  isFillerSound,
  nonVerbalSilenceSettings,
} from "../src/nonverbal.js";

test("uses short quiet gaps to isolate clicks without changing the main silence setting", () => {
  const settings = { thresholdDb: -35, minimumSilence: 0.7 };
  assert.deepEqual(nonVerbalSilenceSettings(settings), { thresholdDb: -35, minimumSilence: 0.18 });
  assert.equal(settings.minimumSilence, 0.7);
});

test("builds a short sound island and includes its surrounding quiet in the cut", () => {
  const islands = buildSoundIslands([
    { start: 1, end: 4 },
    { start: 4.12, end: 8 },
  ], 10);
  assert.deepEqual(islands.find((item) => item.soundStart === 4), { soundStart: 4, soundEnd: 4.12, start: 1, end: 8 });
});

test("automatically removes an isolated sound with no recognized words", () => {
  const result = detectNonVerbalSounds([
    { soundStart: 4, soundEnd: 4.4, start: 2, end: 7 },
  ]);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0], {
    reason: "non-verbal",
    start: 2,
    end: 7,
    soundStart: 4,
    soundEnd: 4.4,
    confidence: 0.99,
    similarity: 0,
    removedText: "No spoken words detected",
    keptText: "",
    applied: true,
  });
});

test("recognizes humming and hesitation sounds but keeps real short words", () => {
  assert.equal(isFillerSound("Ммм"), true);
  assert.equal(isFillerSound("Эм"), true);
  assert.equal(isFillerSound("hmm"), true);
  assert.equal(isFillerSound("да"), false);
  assert.equal(isFillerSound("нет"), false);

  const island = { soundStart: 4, soundEnd: 4.4, start: 2, end: 7 };
  const humming = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.05, end: 4.3, text: " Ммм", probability: 0.92 }],
  });
  const word = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.05, end: 4.3, text: " Да", probability: 0.92 }],
  });
  assert.equal(humming.applied.length, 1);
  assert.equal(word.candidates.length, 0);
});

test("protects words close to a sound boundary and only suggests low-confidence text", () => {
  const island = { soundStart: 4, soundEnd: 4.4, start: 2, end: 7 };
  const protectedWord = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.48, end: 4.7, text: " Да", probability: 0.9 }],
  });
  const uncertain = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.1, end: 4.3, text: " да", probability: 0.12 }],
  });
  assert.equal(protectedWord.candidates.length, 0);
  assert.equal(uncertain.candidates.length, 1);
  assert.equal(uncertain.applied.length, 0);
});

test("treats bracketed Whisper annotations as non-verbal", () => {
  const result = detectNonVerbalSounds([
    { soundStart: 4, soundEnd: 5, start: 2, end: 7 },
  ], {
    tokens: [{ start: 4.1, end: 4.8, text: " sigh", probability: 0.9 }],
    utterances: [{ start: 4, end: 5, text: "[sigh]" }],
  });
  assert.equal(result.applied.length, 1);
});
