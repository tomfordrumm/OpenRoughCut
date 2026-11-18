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

test("recognizes shivers, short breaths, and starred sound annotations", () => {
  assert.equal(isFillerSound("Бррр"), true);
  assert.equal(isFillerSound("brr"), true);
  assert.equal(isFillerSound("пах"), true);

  const island = { soundStart: 4, soundEnd: 4.4, start: 2, end: 7 };
  const annotation = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.05, end: 4.3, text: " звук", probability: 0.95 }],
    utterances: [{ start: 4, end: 4.4, text: "*звук*" }],
  });
  assert.equal(annotation.applied.length, 1);
});

test("removes an exact filler token while protecting a neighboring word", () => {
  const island = { soundStart: 4, soundEnd: 4.4, start: 2, end: 4.6 };
  const result = detectNonVerbalSounds([island], {
    tokens: [
      { start: 4.05, end: 4.3, text: " Ммм", probability: 0.92 },
      { start: 4.48, end: 4.7, text: " И", probability: 0.98 },
    ],
  });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].removedText, "Ммм");
});

test("trims a sound cut before a neighboring word and only suggests uncertain speech", () => {
  const island = { soundStart: 4, soundEnd: 4.4, start: 2, end: 7 };
  const protectedWord = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.48, end: 4.7, text: " Да", probability: 0.9 }],
  });
  const uncertain = detectNonVerbalSounds([island], {
    tokens: [{ start: 4.1, end: 4.3, text: " да", probability: 0.12 }],
  });
  assert.equal(protectedWord.applied.length, 1);
  assert.equal(protectedWord.applied[0].end, 4.44);
  assert.ok(protectedWord.applied[0].end < 4.48);
  assert.equal(uncertain.candidates.length, 1);
  assert.equal(uncertain.applied.length, 0);
});

test('long non-word sound islands are checked, and missing tokens do not erase a lexical utterance', () => {
  const islands = buildSoundIslands([{ start: 0, end: 1 }, { start: 5, end: 6 }], 6);
  assert.equal(islands.length, 1);
  assert.equal(detectNonVerbalSounds(islands).applied.length, 1);
  assert.equal(detectNonVerbalSounds(islands, { utterances: [{ start: 2, end: 3, text: 'Нет.' }] }).applied.length, 0);
});

test('a preserved short word remains protected after rejected speech is removed', () => {
  const island = { soundStart: 1, soundEnd: 5, start: 0, end: 6 };
  const result = detectNonVerbalSounds([island], { removedSpeech: [{ start: 1, end: 3 }], tokens: [{ start: 1, end: 2, text: 'неудачная', probability: .9 }, { start: 4, end: 4.2, text: 'Нет', probability: .9 }] });
  assert.equal(result.applied.length, 0);
});
test('already removed takes are not classified again as non-word sounds', () => {
  const island={soundStart:1,soundEnd:3,start:0,end:4};
  const result=detectNonVerbalSounds([island],{removedSpeech:[{start:1,end:2},{start:2,end:3}],tokens:[{start:1,end:2,text:'Дубль',probability:.9}]});
  assert.equal(result.candidates.length,0);
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
