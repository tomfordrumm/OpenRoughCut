import test from "node:test";
import assert from "node:assert/strict";
import { HELP, parseArgs, runCli } from "../src/cli.js";

const media = { duration: 10, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioChannels: 2, audioRate: 48000 };
const takes = [
  { start: 1, end: 3, text: "Заказ сохраняется в базе данных." },
  { start: 4, end: 7, text: "Заказ сохраняется в базе данных, затем клиент получает уведомление." },
];

// Only media access, probing, transcription and writes are injected.
function fixture({ segments = takes } = {}) {
  const writes = new Map();
  const dependencies = {
    access: async () => {},
    probeMedia: async () => media,
    detectSilences: async () => [],
    transcribeMedia: async () => ({ language: "ru", text: segments.map(s => s.text).join(" "), segments, tokens: [], utterances: segments }),
    writeFile: async (file, data) => { writes.set(file, data); },
  };
  const run = (args = [], options = {}) => runCli(["synthetic.mov", "--project-resolution", "source", ...args], { log: () => {}, dependencies, ...options });
  return { writes, dependencies, run };
}

test("CLI preserves defaults and explicitly selects shared duplicate modes", () => {
  assert.equal(parseArgs(["video.mov"]).duplicateMode, "last-take");
  assert.equal(parseArgs(["video.mov"]).transcribe, undefined);
  assert.equal(parseArgs(["video.mov", "--transcribe"]).duplicateMode, "last-take");
  for (const mode of ["last-take", "rules"]) {
    const options = parseArgs(["video.mov", "--duplicate-mode", mode]);
    assert.equal(options.transcribe, true);
    assert.equal(options.duplicateMode, mode);
    assert.equal(parseArgs(["--text-suggestions-only", "--duplicate-mode", mode]).applyTextEdits, false);
  }
  assert.throws(() => parseArgs(["--duplicate-mode"]), /requires/);
  assert.throws(() => parseArgs(["--duplicate-mode", "cloud"]), /Unsupported/);
  assert.throws(() => parseArgs(["video.mov", "--duplicate-mode", "gemma-conservative"]), /Unsupported/);
  assert.doesNotMatch(HELP, /gemma/i);
});

test("silence and default transcription commands report the expected mode", async () => {
  for (const args of [[], ["--transcribe"], ["--text-suggestions-only"], ["--remove-non-verbal"]]) {
    const f = fixture();
    const result = await f.run(args);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.textEdits?.mode ?? null, args.includes("--transcribe") || args.includes("--text-suggestions-only") ? "last-take" : null);
  }
});

test("last-take CLI mode removes the earlier attempt", async () => {
  const f = fixture();
  const result = await f.run(["--duplicate-mode", "last-take"]);
  const report = JSON.parse(f.writes.get(result.reportPath));
  assert.equal(report.settings.transcription.duplicateMode, "last-take");
  assert.equal(report.settings.transcription.confidenceThreshold, 0.9);
  assert.equal(report.textEdits.summary.reviewPolicy, "last-take-v1");
  assert.equal(report.textEdits.applied.length, 1);
  assert.equal(report.textEdits.applied[0].keptText, takes[1].text);
  assert.deepEqual(report.cuts, [{ startSeconds: 1, endSeconds: 3, durationSeconds: 2 }]);
});

test("transcription errors and cancellation do not write a timeline", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), controller = new AbortController();
    f.dependencies.transcribeMedia = () => { if (cancel) { controller.abort(); controller.signal.throwIfAborted(); } throw new Error("Synthetic failure"); };
    await assert.rejects(f.run(["--duplicate-mode", "last-take"], { signal: controller.signal }), cancel ? { name: "AbortError" } : /Synthetic failure/);
    assert.equal(f.writes.size, 0);
  }
});
