import test from "node:test";
import assert from "node:assert/strict";
import { buildTakeUnits, detectLastTakeEdits, restartStrength } from "../src/last-take.js";

let clock = 0;
// Consecutive segments separated by short pauses, optionally with even word timing.
function speech(texts, { timed = false } = {}) {
  clock = 0;
  return texts.map((text) => {
    const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
    const start = clock, end = start + Math.max(0.5, words.length * 0.3);
    clock = end + 0.8;
    const segment = { start, end, text };
    if (timed) {
      const step = (end - start) / words.length;
      segment.words = words.map((w, i) => ({ startChar: w.index, endChar: w.index + w[0].length, start: start + i * step, end: start + (i + 1) * step - 0.01 }));
    }
    return segment;
  });
}

test("a chain of retakes removes every attempt and the muttering between them, keeping the last", () => {
  const segments = speech([
    "Группа исследователей решила проверить одну вещь.",
    "И результаты оказались не очень.",
    "И результаты немного.",
    "Не расслышал.",
    "И результаты получились неочевидными, успешные бизнесы выросли на 15%.",
    "А неуспешные показали минус 8%.",
  ]);
  const { applied } = detectLastTakeEdits(segments);
  assert.equal(applied.length, 2);
  assert.equal(applied[0].start, segments[1].start);
  assert.equal(applied.at(-1).end, segments[3].end);
  assert.ok(applied.every((c) => c.keptText === segments[4].text && c.method === "last-take" && c.groupId));
  // Neither the introduction, the final take nor the continuation is touched.
  for (const kept of [0, 4, 5]) assert.ok(!applied.some((c) => c.start < segments[kept].end && c.end > segments[kept].start));
});

test("sentences that only share common opening words are not retakes", () => {
  const units = buildTakeUnits(speech(["Потому что модель ошибается в расчётах.", "Потому что люди не проверяют ответы."]));
  assert.equal(restartStrength(units[0], units[1]), 0);
  assert.deepEqual(detectLastTakeEdits(speech(["Например, программирование требует внимания.", "Например, дизайн требует вкуса."])).candidates, []);
});

test("an identical multi-word opening is a restart even when built from common words", () => {
  const units = buildTakeUnits(speech(["И здесь я бы в первую очередь смотрел.", "Ну, здесь я бы в первую очередь смотрел на цену ошибки."]));
  assert.equal(restartStrength(units[0], units[1]), 2);
});

test("a restart inside one segment is cut at the measured word time", () => {
  const [segment] = speech(["И если честно, результат меня не удивил. И если честно, результат этого эксперимента меня не удивил."], { timed: true });
  const { applied } = detectLastTakeEdits([segment]);
  assert.equal(applied.length, 1);
  const restart = segment.words.find((w) => w.startChar === segment.text.indexOf("И если", 5));
  assert.equal(applied[0].start, segment.start);
  assert.ok(applied[0].end < restart.start);
  assert.equal(applied[0].keptText, "И если честно, результат этого эксперимента меня не удивил.");
});

test("an untimed segment is never cut in the middle", () => {
  const segments = speech(["И если честно, результат меня не удивил. И если честно, результат этого эксперимента меня не удивил."]);
  assert.deepEqual(detectLastTakeEdits(segments).candidates, []);
});

test("a flawed final attempt and intervening speech leave suggestions only", () => {
  const broken = detectLastTakeEdits(speech(["Они взяли.", "Они взяли 640 предпринимателей и, блядь…"]));
  assert.equal(broken.candidates.length, 1);
  assert.equal(broken.applied.length, 0);
  const between = detectLastTakeEdits(speech([
    "Средний результат вырос заметно.",
    "Это касается всех участников эксперимента, кроме самой слабой группы с самыми низкими исходными оценками.",
    "Средний результат вырос заметно у всех.",
  ]));
  assert.equal(between.applied.length, 0);
  assert.ok(between.candidates[0].confidence < 0.9);
});

test("recording instructions are removed; a lone soft word is only suggested", () => {
  const { candidates, applied } = detectLastTakeEdits(speech(["Запись началась, погнали.", "Сегодня разберём одну статью.", "Сейчас."]));
  assert.deepEqual(applied.map((c) => c.removedText), ["Запись началась, погнали."]);
  assert.deepEqual(candidates.filter((c) => !c.autoEligible).map((c) => c.removedText), ["Сейчас."]);
});

test("the auto-remove threshold is configurable", () => {
  const segments = speech(["Они взяли.", "Они взяли 640 предпринимателей в Кении."]);
  assert.equal(detectLastTakeEdits(segments).applied.length, 1);
  assert.equal(detectLastTakeEdits(segments, { autoConfidence: 0.99 }).applied.length, 0);
});

test("interleaved retakes keep each line's final take", () => {
  const segments = speech([
    "Согласись, бесит, когда нейросеть делает плохой сайт.",
    "Хорошие новости. Ты можешь… Давай ещё раз.",
    "Согласись, бесит, когда нейросеть делает тебе плохой сайт.",
    "Хорошие новости. Ты можешь обучить нейросеть новым навыкам.",
  ]);
  const { applied } = detectLastTakeEdits(segments);
  for (const kept of [2, 3]) assert.ok(!applied.some((c) => c.start < segments[kept].end && c.end > segments[kept].start), `take ${kept} must stay`);
  for (const removed of [0, 1]) assert.ok(applied.some((c) => c.start <= segments[removed].start && c.end >= segments[removed].end), `take ${removed} must go`);
});

test("sound annotations and single words never form a retake", () => {
  const segments = speech(["*Кхм*", "Но есть важный момент, о котором стоит сказать.", "*Кхм*", "Угу.", "Угу."]);
  assert.deepEqual(detectLastTakeEdits(segments).candidates, []);
});

test("candidates carry the kept take's range so the review can play and choose it", () => {
  const segments = speech(["И результаты оказались не очень.", "Пауза на подумать.", "И результаты получились неочевидными."]);
  const { candidates } = detectLastTakeEdits(segments);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].keptRanges, [{ start: segments[2].start, end: segments[2].end }]);
});
