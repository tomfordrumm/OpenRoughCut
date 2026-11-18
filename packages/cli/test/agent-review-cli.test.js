import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runCli, decisionsCommand } from "../src/cli.js";

const media = { duration: 30, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioChannels: 2, audioRate: 48000 };
const segments = [
  { start: 1, end: 3, text: "Ссылки на все три скилла я оставил в канале." },
  { start: 4, end: 6, text: "Пиши в комменты слово дизайн." },
  { start: 7, end: 11, text: "Ссылки на все три скилла я оставил в канале, пиши слово дизайн." },
  { start: 12, end: 15, text: "Ну и подписывайся, чтобы не пропустить новые видео." },
];

test("CLI writes a review packet, then applies decisions without transcribing again", async () => {
  const files = new Map();
  let transcriptions = 0;
  const dependencies = {
    access: async () => {},
    probeMedia: async () => media,
    detectSilences: async () => [],
    transcribeMedia: async () => { transcriptions++; return { language: "ru", text: "", segments, tokens: [], utterances: segments }; },
    writeFile: async (file, data) => { files.set(file, data); },
    readFile: async (file) => { if (!files.has(file)) throw new Error("missing"); return files.get(file); },
    // Each path stands for different bytes, so a renamed copy is "another recording".
    fingerprintSource: async (file) => ({ sizeBytes: 1000, sampleSha256: `sha:${file}` }),
  };
  const run = (args) => runCli(["/work/video.mov", "--project-resolution", "source", ...args], { log: () => {}, dependencies });

  const first = await run(["--review", "/work/video.review.json"]);
  assert.equal(transcriptions, 1);
  assert.equal(first.reviewPath, "/work/video.review.json");
  assert.deepEqual(first.report.cuts.map((c) => [c.startSeconds, c.endSeconds]), [[1, 6]]);
  const review = JSON.parse(files.get("/work/video.review.json"));
  assert.equal(review.candidates[0].id, "c1");

  files.set("/work/decisions.json", JSON.stringify({ ...review.decisionsTemplate, review: "video.review.json", cut: [{ units: ["u4"], reason: "test" }] }));
  const second = await run(["--decisions", "/work/decisions.json"]);
  assert.equal(transcriptions, 1, "decisions reuse the packet's transcript");
  assert.deepEqual(second.report.cuts.map((c) => [c.startSeconds, c.endSeconds]), [[1, 6], [12, 15]]);
  assert.equal(second.report.textEdits.summary.agentDecisions.cut[0].reason, "test");

  assert.equal(review.input.sampleSha256, "sha:/work/video.mov");
  files.set("/work/review.json", JSON.stringify({ ...review, input: { ...review.input, durationSeconds: 99 } }));
  files.set("/work/other.json", JSON.stringify({ ...review.decisionsTemplate, review: "review.json" }));
  await assert.rejects(run(["--decisions", "/work/other.json"]), /different recording/);
});

test("CLI rejects contradictory agent options", () => {
  assert.equal(parseArgs(["v.mov", "--review", "r.json"]).transcribe, true);
  assert.throws(() => parseArgs(["v.mov", "--review"]), /requires a path/);
  assert.throws(() => parseArgs(["v.mov", "--review", "r.json", "--decisions", "d.json"]), /cannot also write/);
  assert.throws(() => parseArgs(["v.mov", "--decisions", "d.json", "--duplicate-mode", "rules"]), /review packet/);
  assert.throws(() => parseArgs(["v.mov", "--decisions", "d.json", "--text-suggestions-only"]), /suggestions-only/);
});

test("the apply command repeats this run's analysis settings", async () => {
  assert.equal(
    decisionsCommand(["/my videos/a.mov", "--threshold", "-28", "--review", "r.json", "--transcribe", "--duplicate-mode", "last-take", "--remove-non-verbal"]),
    "openroughcut '/my videos/a.mov' --threshold -28 --remove-non-verbal --decisions <decisions.json>",
  );
});

test("decisions for a different recording of the same length are refused", async () => {
  const files = new Map();
  const dependencies = {
    access: async () => {}, probeMedia: async () => media, detectSilences: async () => [],
    transcribeMedia: async () => ({ language: "ru", text: "", segments, tokens: [], utterances: segments }),
    writeFile: async (file, data) => { files.set(file, data); },
    readFile: async (file) => { if (!files.has(file)) throw new Error("missing"); return files.get(file); },
    fingerprintSource: async (file) => ({ sizeBytes: 1000, sampleSha256: `sha:${file}` }),
  };
  await runCli(["/work/original.mov", "--project-resolution", "source", "--review", "/work/r.json"], { log: () => {}, dependencies });
  const review = JSON.parse(files.get("/work/r.json"));
  files.set("/work/d.json", JSON.stringify({ ...review.decisionsTemplate, review: "r.json" }));
  const other = (input) => runCli([input, "--project-resolution", "source", "--decisions", "/work/d.json"], { log: () => {}, dependencies });
  await assert.rejects(other("/work/different-recording.mov"), /different recording/);
  const { sizeBytes: _s, sampleSha256: _h, ...legacyInput } = review.input;
  files.set("/work/r.json", JSON.stringify({ ...review, input: legacyInput }));
  await assert.rejects(other("/work/original.mov"), /does not identify its recording/);
});
