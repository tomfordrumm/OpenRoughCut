import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentDecisions, buildReviewPacket, DECISIONS_FORMAT, REVIEW_FORMAT } from "../src/agent-review.js";
import { detectLastTakeEdits } from "../src/last-take.js";

const media = { duration: 30, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioChannels: 2, audioRate: 48000 };
const segments = [
  { start: 1, end: 3, text: "Ссылки на все три скилла я оставил в канале." },
  { start: 4, end: 6, text: "Пиши в комменты слово дизайн." },
  { start: 7, end: 11, text: "Ссылки на все три скилла я оставил в канале, пиши слово дизайн." },
  { start: 12, end: 15, text: "Ну и подписывайся, чтобы не пропустить новые видео." },
];

function packet(options = {}) {
  const textEdits = detectLastTakeEdits(segments, options);
  return buildReviewPacket({
    inputPath: "/video.mov", media, transcript: { language: "ru", segments, tokens: [], utterances: segments },
    textEdits, applied: textEdits.applied, reviewPath: "/video.review.json", outputPath: "/video.fcpxml",
    settings: { duplicateMode: "last-take", textConfidence: 0.9 },
  });
}
const decide = (fields) => ({ format: DECISIONS_FORMAT, review: "/video.review.json", ...fields });

test("review packet lists units, the detector's cut and the take it keeps", () => {
  const review = packet();
  assert.equal(review.format, REVIEW_FORMAT);
  assert.deepEqual(review.units.map((u) => u.id), ["u1", "u2", "u3", "u4"]);
  assert.equal(review.candidates.length, 1);
  const [c1] = review.candidates;
  // Last-take removes the first attempt and the CTA in between, keeps u3.
  assert.deepEqual([c1.id, c1.applied, c1.units, c1.keptUnit], ["c1", true, ["u1", "u2"], "u3"]);
  assert.deepEqual(review.units.map((u) => u.cutBy), ["c1", "c1", null, null]);
  assert.equal(review.decisionsTemplate.review, "/video.review.json");
  assert.ok(review.instructions.some((line) => /LAST complete attempt/.test(line)));
});

test("empty decisions reproduce the detector's cuts", () => {
  const review = packet();
  const edits = applyAgentDecisions(review, decide({}));
  assert.deepEqual(edits.applied.map((c) => [c.start, c.end]), [[1, 6]]);
});

test("keep, remove and cut become text edits with reasons", () => {
  const review = packet({ autoConfidence: 0.99 }); // c1 becomes a suggestion only
  assert.equal(review.candidates[0].applied, false);
  const edits = applyAgentDecisions(review, decide({
    remove: [{ id: "c1", reason: "earlier attempt of the closing line" }],
  }));
  assert.deepEqual(edits.applied.map((c) => [c.start, c.end]), [[1, 6]]);

  const restored = applyAgentDecisions(packet(), decide({
    keep: ["c1"],
    cut: [{ units: ["u2"], reason: "superseded call to action" }],
  }));
  assert.deepEqual(restored.applied.map((c) => [c.start, c.end, c.method]), [[4, 6, "agent"]]);
  assert.equal(restored.applied[0].reviewNote, "superseded call to action");
  assert.deepEqual(restored.summary.agentDecisions.kept, [{ id: "c1", reason: null }]);
});

test("choosing an earlier take means keeping the candidate and cutting the later take", () => {
  const review = packet();
  assert.throws(() => applyAgentDecisions(review, decide({ cut: [{ units: ["u3"] }] })), /u3 is the take c1 keeps/);
  const edits = applyAgentDecisions(review, decide({ keep: ["c1"], cut: [{ units: ["u3"], reason: "first take reads better" }] }));
  assert.deepEqual(edits.applied.map((c) => [c.start, c.end]), [[7, 11]]);
});

test("agent mistakes are rejected instead of becoming different edits", () => {
  const review = packet();
  const bad = [
    [{ format: "v0" }, /format/],
    [decide({ extra: 1 }), /unknown field `extra`/],
    [decide({ keep: ["c9"] }), /unknown candidate c9/],
    [decide({ remove: ["c1"] }), /already cut/],
    [decide({ keep: ["c1"], remove: ["c1"] }), /both/],
    [decide({ cut: [{ units: ["u9"] }] }), /unknown unit u9/],
    [decide({ cut: [{ units: [] }] }), /non-empty/],
    [decide({ cut: [{ units: ["u4"] }, { units: ["u4"] }] }), /cut twice/],
    [decide({ cut: [{ units: ["u2"] }] }), /already cut/],
    [decide({ keep: ["c1"], cut: [{ units: ["u1", "u3"] }] }), /skips u2/],
  ];
  for (const [decisions, message] of bad) assert.throws(() => applyAgentDecisions(review, decisions), message);
  const unapplied = packet({ autoConfidence: 0.99 });
  assert.throws(() => applyAgentDecisions(unapplied, decide({ keep: ["c1"] })), /not cut/);
});

// The rules detector describes the kept take only by text, without a
// last-take unit id, and may lack exact word timing.
function textOnlyPacket(candidates) {
  const segs = [
    { start: 1, end: 4, text: "Сервер создаёт заказ. Важная подробность про подпись." },
    { start: 5, end: 8, text: "Сервер создаёт заказ и проверяет подпись." },
    { start: 9, end: 12, text: "Дальше идёт оплата." },
  ];
  const textEdits = { candidates, applied: candidates.filter((c) => c.applied), summary: { reviewPolicy: "whole-chain-v5" } };
  return buildReviewPacket({
    inputPath: "/v.mov", fingerprint: { sizeBytes: 1, sampleSha256: "x" }, media, transcript: { segments: segs },
    textEdits, applied: textEdits.applied, reviewPath: "/v.review.json", outputPath: "/v.fcpxml", settings: {},
  });
}

test("a suggestion without exact word timing cannot be applied", () => {
  const untimed = { start: 1, end: 4, reason: "repeated-take", removedText: "Сервер создаёт заказ.", keptText: "Сервер создаёт заказ и проверяет подпись.", canApply: false, method: "rules" };
  const review = textOnlyPacket([untimed]);
  assert.equal(review.candidates[0].timed, false);
  assert.throws(() => applyAgentDecisions(review, decide({ remove: ["c1"] })), /no exact word timing/);
  // Cutting the whole unit is an explicit, visible decision about every word in it.
  assert.deepEqual(applyAgentDecisions(review, decide({ cut: [{ units: ["u1"] }] })).applied.map((c) => [c.start, c.end]), [[1, 4]]);
});

test("the kept take is protected even when the detector names it only by text", () => {
  const pair = { start: 1, end: 4, reason: "repeated-take", removedText: "Сервер создаёт заказ.", keptText: "Сервер создаёт заказ и проверяет подпись.", canApply: true, applied: true, method: "rules" };
  const review = textOnlyPacket([pair]);
  assert.deepEqual(review.candidates[0].keptUnits, ["u2"]);
  assert.throws(() => applyAgentDecisions(review, decide({ cut: [{ units: ["u2"] }] })), /u2 is the take c1 keeps/);

  const suggestion = textOnlyPacket([{ ...pair, applied: false }]);
  assert.throws(() => applyAgentDecisions(suggestion, decide({ remove: ["c1"], cut: [{ units: ["u2"] }] })), /u2 is the take c1 keeps/);

  // Kept text that matches no unit: nearby cuts are refused until the candidate is kept.
  const lost = textOnlyPacket([{ ...pair, keptText: "Совсем другая формулировка." }]);
  assert.deepEqual(lost.candidates[0].keptUnits, []);
  assert.throws(() => applyAgentDecisions(lost, decide({ cut: [{ units: ["u2"] }] })), /could not be located/);
  assert.doesNotThrow(() => applyAgentDecisions(lost, decide({ keep: ["c1"], cut: [{ units: ["u2"] }] })));
  assert.throws(() => applyAgentDecisions(textOnlyPacket([{ ...pair, applied: false, keptText: "Совсем другая формулировка." }]), decide({ remove: ["c1"] })), /could not be located/);
});

test("candidates with kept time ranges locate the kept take by range", () => {
  const grouped = { start: 1, end: 4, reason: "repeated-take", removedText: "x", keptText: "y", keptRanges: [{ start: 5, end: 8 }], winnerId: "group-7:attempt-2", canApply: true, applied: true };
  assert.deepEqual(textOnlyPacket([grouped]).candidates[0].keptUnits, ["u2"]);
});

test("the source fingerprint tells apart files that differ only past the first bytes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { sourceFingerprint, assertSameSource } = await import("../src/agent-review.js");
  const dir = await mkdtemp(join(tmpdir(), "orc-fingerprint-"));
  try {
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    await writeFile(join(dir, "a.mov"), big);
    big[big.length - 1] = 8;
    await writeFile(join(dir, "b.mov"), big);
    const a = await sourceFingerprint(join(dir, "a.mov"));
    const b = await sourceFingerprint(join(dir, "b.mov"));
    assert.equal(a.sizeBytes, b.sizeBytes);
    assert.notEqual(a.sampleSha256, b.sampleSha256);
    assert.doesNotThrow(() => assertSameSource({ input: { ...a, durationSeconds: 10 } }, a, 10));
    assert.throws(() => assertSameSource({ input: { ...a, durationSeconds: 10 } }, b, 10), /different recording/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
