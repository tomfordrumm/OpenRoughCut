// The CLI and the desktop app must drive the same core pipeline and, on the
// same recording and settings, export the same edit.
import test from "node:test";
import assert from "node:assert/strict";
import * as core from "@openroughcut/core";
import { resolveProjectResolution } from "@openroughcut/core/resolution.js";
import { runCli } from "@openroughcut/cli";
import { analyzeSource, exportSource } from "../apps/desktop/src/desktop-pipeline.js";

const media = { duration: 20, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioChannels: 2, audioRate: 48000 };
const segments = [
  { start: 1, end: 3, text: "Заказ сохраняется в базе данных." },
  { start: 4, end: 7, text: "Заказ сохраняется в базе данных, затем клиент получает уведомление." },
  { start: 8.5, end: 10, text: "Это важно." },
  { start: 11.2, end: 13.5, text: "Потом мы проверяем подпись запроса." },
  { start: 14, end: 17, text: "Потом мы проверяем подпись входящего запроса." },
];
const silences = [{ start: 3, end: 4 }, { start: 7, end: 8.5 }, { start: 13.5, end: 14 }, { start: 17, end: 20 }];
// A click splits the 10–11.2 s pause: only the shorter transcription-pause pass sees its halves.
const clickSplitPause = [{ start: 10, end: 10.55 }, { start: 10.56, end: 11.2 }];
const silencesFor = ({ minimumSilence }) => (minimumSilence >= 0.7 ? silences : [...silences, ...clickSplitPause].sort((a, b) => a.start - b.start));

function io() {
  const writes = new Map();
  return {
    writes,
    dependencies: {
      access: async () => {},
      probeMedia: async () => media,
      detectSilences: async (_input, settings) => silencesFor(settings),
      transcribeMedia: async () => ({ language: "ru", text: segments.map((s) => s.text).join(" "), segments, tokens: [], utterances: segments }),
      writeFile: async (file, data) => { writes.set(file, data); },
    },
  };
}

// Records the order of core calls while delegating to the real core.
function observedPipeline(calls) {
  const wrap = (name) => (...args) => { calls.push(name); return core[name](...args); };
  return { analyze: wrap("analyze"), applyDecisions: wrap("applyDecisions"), buildPlan: wrap("buildPlan"), exportPlan: wrap("exportPlan"), createReport: core.createReport };
}

async function viaCli({ textConfidence, extra = [] }) {
  const { writes, dependencies } = io();
  const calls = [];
  const result = await runCli(["/work/talk.mov", "--project-resolution", "source", "--duplicate-mode", "last-take", "--text-confidence", String(textConfidence), ...extra],
    { log: () => {}, dependencies, pipeline: observedPipeline(calls) });
  return { calls, timeline: writes.get(result.outputPath), cuts: result.report.cuts };
}

async function viaDesktop({ textConfidence }) {
  const { writes, dependencies } = io();
  const calls = [];
  const pipeline = observedPipeline(calls);
  const runtime = { ffmpeg: { command: "ffmpeg" }, ffprobe: { command: "ffprobe" }, whisper: { command: "whisper-cli" }, model: { path: "/m/base.bin" }, vadModel: { path: "/m/vad.bin" } };
  const request = { settings: { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18 }, includeTranscript: true, removeNonVerbal: false, textConfidence, transcriptionModelId: "base", duplicateMode: "last-take" };
  const analysis = await analyzeSource({ sourcePath: "/work/talk.mov", media, request, runtime, pipeline, dependencies });
  // The renderer stores this analysis and sends it back with the export request.
  const { plan } = await exportSource({
    sourcePath: "/work/talk.mov", media, analysis: structuredClone(analysis), manualOverrides: [], keepPause: request.settings.keepPause,
    exportFormat: "final-cut", projectResolution: resolveProjectResolution(media, "source"), outputPath: "/work/talk.roughcut.fcpxml", runtime, pipeline, dependencies,
  });
  return { calls, timeline: writes.get("/work/talk.roughcut.fcpxml"), plan };
}

test("CLI and desktop call the same core pipeline steps in the same order", async () => {
  const cli = await viaCli({ textConfidence: 0.9 });
  const desktop = await viaDesktop({ textConfidence: 0.9 });
  assert.deepEqual(cli.calls, ["analyze", "buildPlan", "exportPlan"]);
  assert.deepEqual(desktop.calls, cli.calls);
});

test("CLI and desktop export the same timeline for the same recording and settings", async () => {
  // 0.9 applies the repeated takes; 0.99 leaves them as suggestions only, the
  // case where the CLI used to skip the cleanup the desktop ran.
  for (const textConfidence of [0.9, 0.99]) {
    const cli = await viaCli({ textConfidence });
    const desktop = await viaDesktop({ textConfidence });
    assert.ok(cli.timeline && desktop.timeline);
    assert.equal(cli.timeline, desktop.timeline, `same FCPXML at confidence ${textConfidence}`);
    assert.deepEqual(cli.cuts.map((c) => [c.startSeconds, c.endSeconds]), desktop.plan.removals.map((r) => [r.startFrame / 30, r.endFrame / 30]));
  }
});
