import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRegionTiming, parseRegionTranscription, parseTranscription, transcribeMedia, whisperArguments } from "../src/transcribe.js";

test("parses whisper.cpp full JSON into timestamped transcript segments", () => {
  const result = parseTranscription({
    result: { language: "ru" },
    transcription: [
      { offsets: { from: 1000, to: 2500 }, text: " Первый дубль." },
      { offsets: { from: 3000, to: 4500 }, text: " Второй дубль." },
    ],
  });
  assert.equal(result.language, "ru");
  assert.equal(result.text, "Первый дубль. Второй дубль.");
  assert.deepEqual(result.segments[0], { start: 1, end: 2.5, text: "Первый дубль." });
});

test("transcribes isolated region files with VAD in one Whisper invocation", () => {
  const args = whisperArguments({
    modelPath: "/models/base.bin",
    audioPaths: ["/tmp/region-1.wav", "/tmp/region-2.wav"],
    vadModelPath: "/models/vad.bin",
    language: "auto",
    useGpu: false,
  });
  assert.equal(args[0], "-ng");
  assert.ok(args.includes("-ojf"));
  assert.ok(args.includes("--vad"));
  assert.deepEqual(args.slice(-2), ["/tmp/region-1.wav", "/tmp/region-2.wav"]);
});

test("passes a vocabulary prompt and thread count to whisper-cli", () => {
  const args = whisperArguments({
    modelPath: "/models/small.bin",
    audioPaths: ["/tmp/region-1.wav"],
    vadModelPath: "/models/vad.bin",
    language: "ru",
    prompt: "  Claude Code,\n нейросеть ",
    threads: 6,
  });
  const at = args.indexOf("--prompt");
  assert.equal(args[at + 1], "Claude Code, нейросеть");
  assert.equal(args[args.indexOf("-t") + 1], "6");
  assert.equal(args.at(-1), "/tmp/region-1.wav");
  assert.ok(!whisperArguments({ modelPath: "m", audioPaths: ["a"], vadModelPath: "v", language: "ru", prompt: " " }).includes("--prompt"));
});

test("maps a multi-segment transcript back to its complete source region", () => {
  const result = parseRegionTranscription({
    result: { language: "ru" },
    transcription: [
      { text: " По сути классическая схема." },
      { text: " Дорогой архитектор и дешевый исполнитель." },
    ],
  }, { start: 38.69, end: 43.83 });
  assert.deepEqual(result, {
    language: "ru",
    start: 38.69,
    end: 43.83,
    text: "По сути классическая схема. Дорогой архитектор и дешевый исполнитель.",
  });
  assert.equal(parseRegionTranscription({ transcription: [] }, { start: 1, end: 2 }), null);
});

test("maps Whisper token timing from an extracted file back to the source", () => {
  const result = parseRegionTiming({
    transcription: [{
      offsets: { from: 500, to: 1400 },
      text: " Да.",
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 0.9 },
        { text: "[_TT_232]", offsets: { from: 0, to: 0 }, p: 0.9 },
        { text: " Да", offsets: { from: 520, to: 900 }, p: 0.84 },
        { text: ".", offsets: { from: 900, to: 900 }, p: 0.4 },
      ],
    }],
  }, { start: 10, end: 12, audioStart: 9.8, audioEnd: 12.2 });
  assert.deepEqual(result.utterances, [{ start: 10.3, end: 11.2, text: "Да." }]);
  assert.deepEqual(result.tokens, [
    { start: 10.32, end: 10.7, text: " Да", probability: 0.84 },
    { start: 10.7, end: 10.72, text: ".", probability: 0.4 },
  ]);
});

test("detects language from one speech island and locks it for the remaining regions", async () => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "roughcut-transcribe-test-"));
  const modelPath = path.join(fixtureDirectory, "model.bin");
  const vadModelPath = path.join(fixtureDirectory, "vad.bin");
  await Promise.all([writeFile(modelPath, "model"), writeFile(vadModelPath, "vad")]);
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "audio");
      return;
    }
    const regionPaths = args.filter((argument) => /region-\d+\.wav$/.test(argument));
    await Promise.all(regionPaths.map((regionPath) => {
      const index = Number(path.basename(regionPath).match(/\d+/)[0]);
      return writeFile(`${regionPath}.json`, JSON.stringify({
      result: { language: "ru" },
      transcription: index === 1 ? [] : [
        { text: ` take ${index + 1}, part one` },
        { text: "part two" },
      ],
      }));
    }));
  };

  try {
    const result = await transcribeMedia("source.mov", {
      regions: [
        { start: 10, end: 13, audioStart: 9.8, audioEnd: 13.2 },
        { start: 20, end: 22, audioStart: 19.8, audioEnd: 22.2 },
        { start: 30, end: 35, audioStart: 29.8, audioEnd: 35.2 },
      ],
      modelPath,
      vadModelPath,
      useGpu: false,
      runCommand,
      extractionConcurrency: 2,
    });

    const whisperCalls = calls.filter((call) => call.command === "whisper-cli");
    assert.equal(whisperCalls.length, 2);
    assert.deepEqual(whisperCalls[0].args.slice(-1).map((item) => path.basename(item)), ["region-00002.wav"]);
    assert.equal(whisperCalls[0].args[whisperCalls[0].args.indexOf("-l") + 1], "auto");
    assert.equal(whisperCalls[1].args[whisperCalls[1].args.indexOf("-l") + 1], "ru");
    assert.equal(calls.filter((call) => call.command === "ffmpeg").length, 4);
    assert.deepEqual(result.segments, [
      { start: 10, end: 13, text: "take 1, part one part two" },
      { start: 30, end: 35, text: "take 3, part one part two" },
    ]);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("falls back to CPU when GPU transcription is unavailable", async () => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "roughcut-gpu-fallback-test-"));
  const modelPath = path.join(fixtureDirectory, "model.bin");
  const vadModelPath = path.join(fixtureDirectory, "vad.bin");
  await Promise.all([writeFile(modelPath, "model"), writeFile(vadModelPath, "vad")]);
  const whisperCalls = [];
  const runCommand = async (command, args) => {
    if (command === "ffmpeg") {
      await writeFile(args.at(-1), "audio");
      return;
    }
    whisperCalls.push(args);
    if (!args.includes("-ng")) throw new Error("GPU allocation failed");
    const regionPath = args.find((argument) => /region-\d+\.wav$/.test(argument));
    await writeFile(`${regionPath}.json`, JSON.stringify({
      result: { language: "ru" },
      transcription: [{ text: " Повторный дубль." }],
    }));
  };

  try {
    const result = await transcribeMedia("source.mov", {
      regions: [{ start: 4, end: 8 }],
      modelPath,
      vadModelPath,
      language: "ru",
      runCommand,
    });
    assert.equal(whisperCalls.length, 2);
    assert.equal(whisperCalls[0].includes("-ng"), false);
    assert.equal(whisperCalls[1].includes("-ng"), true);
    assert.deepEqual(result.segments, [{ start: 4, end: 8, text: "Повторный дубль." }]);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
});

test("failed or cancelled extraction waits for in-flight jobs before removing temporary audio", async () => {
  for (const cancelled of [false, true]) {
    const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "roughcut-extract-cleanup-test-"));
    const modelPath = path.join(fixtureDirectory, "model.bin"), vadModelPath = path.join(fixtureDirectory, "vad.bin");
    await Promise.all([writeFile(modelPath, "model"), writeFile(vadModelPath, "vad")]);
    const controller = new AbortController();
    let release, announceFailure, temporaryDirectory, active = 0, extractions = 0;
    const inFlight = new Promise(resolve => { release = resolve; });
    const failed = new Promise(resolve => { announceFailure = resolve; });
    const runCommand = async (_command, args) => {
      const output = args.at(-1);
      temporaryDirectory = path.dirname(output);
      if (path.basename(output) === "audio.wav") { await writeFile(output, "audio"); return; }
      extractions++;
      if (path.basename(output) === "region-00000.wav") {
        // Let the second worker enter its extraction before this one fails.
        await Promise.resolve();
        if (cancelled) controller.abort();
        announceFailure();
        if (cancelled) controller.signal.throwIfAborted();
        throw new Error("Extraction failed");
      }
      active++;
      try { await inFlight; await writeFile(output, "audio"); }
      finally { active--; }
    };
    let analysis;
    try {
      analysis = transcribeMedia("source.mov", {
        regions: [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 5 }],
        modelPath, vadModelPath, runCommand, extractionConcurrency: 2, signal: controller.signal,
      });
      // Attach rejection handling now, while one extractor is still in flight.
      const rejected = assert.rejects(analysis, cancelled ? { name: "AbortError" } : /Extraction failed/);
      await failed;
      assert.equal(active, 1);
      await access(temporaryDirectory);
      release();
      await rejected;
      assert.equal(active, 0);
      assert.equal(extractions, 2);
      await assert.rejects(access(temporaryDirectory), { code: "ENOENT" });
    } finally {
      release(); await analysis?.catch(() => {});
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  }
});
