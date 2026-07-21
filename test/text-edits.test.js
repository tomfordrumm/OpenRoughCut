import test from "node:test";
import assert from "node:assert/strict";
import { detectTextEdits, normalizeWords, phraseSimilarity } from "../src/text-edits.js";

test("normalizes words across Latin and Cyrillic text", () => {
  assert.deepEqual(normalizeWords("WebCoder обещает — скоро!"), ["webcoder", "обещает", "скоро"]);
});

test("scores exact repeats above rephrased and unrelated text", () => {
  const exact = phraseSimilarity("весь код будут писать агенты", "весь код будут писать агенты");
  const rephrased = phraseSimilarity("весь код будут писать агенты", "агенты скоро напишут весь код");
  const unrelated = phraseSimilarity("весь код будут писать агенты", "сегодня хорошая погода");
  assert.ok(exact > rephrased);
  assert.ok(rephrased > unrelated);
});

test("auto-applies an obvious false start and keeps the later complete take", () => {
  const result = detectTextEdits([
    { start: 10, end: 12, text: "WebCoder обещает, что скоро..." },
    { start: 15, end: 20, text: "WebCoder обещает, что скоро весь код будут писать агенты." },
  ]);
  assert.equal(result.candidates[0].reason, "false-start");
  assert.equal(result.candidates[0].start, 10);
  assert.equal(result.candidates[0].end, 15);
  assert.equal(result.applied.length, 1);
});

test("auto-applies exact repeated takes but only suggests weaker matches", () => {
  const result = detectTextEdits([
    { start: 0, end: 3, text: "Сегодня мы создадим новый проект." },
    { start: 5, end: 8, text: "Сегодня мы создадим новый проект." },
    { start: 12, end: 15, text: "Сегодня мы создадим наш новый проект." },
  ], { autoConfidence: 0.95 });
  assert.ok(result.applied.some((item) => item.reason === "repeated-take" && item.start === 0 && item.end === 5));
  assert.ok(result.candidates.length > result.applied.length);
});

test("ignores similar text outside the retry window", () => {
  const result = detectTextEdits([
    { start: 0, end: 3, text: "Сегодня мы создадим новый проект." },
    { start: 30, end: 33, text: "Сегодня мы создадим новый проект." },
  ]);
  assert.deepEqual(result.candidates, []);
});

test("uses start-to-start retry distance when VAD stretches a segment across silence", () => {
  const result = detectTextEdits([
    { start: 0, end: 25, text: "Сегодня мы создадим новый проект." },
    { start: 30, end: 33, text: "Сегодня мы создадим новый проект." },
  ]);
  assert.deepEqual(result.candidates, []);
});
