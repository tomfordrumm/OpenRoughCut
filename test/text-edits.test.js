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
  assert.equal(result.candidates[0].end, 12);
  assert.equal(result.applied.length, 1);
});

test("auto-applies exact repeated takes but only suggests weaker matches", () => {
  const result = detectTextEdits([
    { start: 0, end: 3, text: "Сегодня мы создадим новый проект." },
    { start: 5, end: 8, text: "Сегодня мы создадим новый проект." },
    { start: 12, end: 15, text: "Сегодня мы создадим наш новый проект." },
  ], { autoConfidence: 0.95 });
  assert.ok(result.applied.some((item) => item.reason === "repeated-take" && item.start === 0 && item.end === 3));
  assert.ok(result.candidates.length > result.applied.length);
});

test("uses the pause after a phrase as the retry window", () => {
  const result = detectTextEdits([
    { start: 0, end: 10, text: "Сегодня мы создадим новый проект." },
    { start: 24, end: 30, text: "Сегодня мы создадим новый проект." },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].start, 0);
  assert.equal(result.candidates[0].end, 10);
});

test("ignores similar text when the pause between phrases exceeds the retry window", () => {
  const result = detectTextEdits([
    { start: 0, end: 3, text: "Сегодня мы создадим новый проект." },
    { start: 30, end: 33, text: "Сегодня мы создадим новый проект." },
  ]);
  assert.deepEqual(result.candidates, []);
});

test("marks every earlier speech region in a three-take chain and points to the final take", () => {
  const finalTake = "По сути классическая схема – дорогой архитектор и дешевый исполнитель звучит абсолютно логично.";
  const result = detectTextEdits([
    { start: 38.69, end: 43.83, text: "По сути классическая схема – дорогой архитектор и дешевый исполнитель – абсолютная классика." },
    { start: 45.29, end: 46.35, text: "А нет, только что сказали." },
    { start: 47.42, end: 53.21, text: "По сути классическая схема – дорогой архитектор и дешевый исполнитель, вроде звучит логично." },
    { start: 54.72, end: 60, text: finalTake },
  ]);
  const repeated = result.candidates.filter((item) => item.reason === "repeated-take");
  assert.deepEqual(repeated.map((item) => [item.start, item.end]), [[38.69, 43.83], [47.42, 53.21]]);
  assert.ok(repeated.every((item) => item.keptText === finalTake));
});

test("finds a repeated take when one region contains a lead-in before the shared sentence", () => {
  const finalTake = "Проблема только в том, что в реальных тестах эта схема оказалась одновременно дороже, медленнее и ничуть не лучше.";
  const result = detectTextEdits([
    { start: 91.84, end: 97.4, text: "Звучит абсолютно логично. Проблема только в том, что в реальных тестах эта схема оказалась на время дороже, медленнее." },
    { start: 98.88, end: 102.69, text: "Проблема только в том, что в реальных тестах эта схема оказалась дороже." },
    { start: 115.33, end: 124.32, text: finalTake },
  ]);
  assert.deepEqual(result.candidates.map((item) => item.start), [91.84, 98.88]);
  assert.ok(result.candidates.every((item) => item.keptText === finalTake));
});

test("suggests an immediate short retry even when most words were transcribed badly", () => {
  const result = detectTextEdits([
    { start: 113.02, end: 114.77, text: "Проблема толкотом. Блесла." },
    { start: 115.33, end: 124.32, text: "Проблема только в том, что в реальных тестах эта схема оказалась одновременно дороже, медленнее и ничуть не лучше." },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].reason, "false-start");
  assert.equal(result.candidates[0].confidence, 0.78);
  assert.equal(result.applied.length, 0);
});
