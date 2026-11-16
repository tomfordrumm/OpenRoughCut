import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./process.js";
import { alignWordTiming } from "./word-timing.js";


function parseTranscription(data) {
  const segments = (data.transcription ?? [])
    .map((segment) => ({
      start: Number(segment.offsets?.from) / 1000,
      end: Number(segment.offsets?.to) / 1000,
      text: String(segment.text ?? "").trim(),
    }))
    .filter((segment) => Number.isFinite(segment.start)
      && Number.isFinite(segment.end)
      && segment.end > segment.start
      && segment.text);

  return {
    language: data.result?.language ?? "unknown",
    segments,
    text: segments.map((segment) => segment.text).join(" "),
  };
}

export function parseRegionTranscription(data, region) {
  const text = (data.transcription ?? [])
    .map((segment) => String(segment?.text ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (!text) return null;
  return {
    language: data.result?.language ?? "unknown",
    start: region.start,
    end: region.end,
    text,
  };
}

function absoluteOffset(region, milliseconds) {
  const audioStart = Number(region?.audioStart ?? region?.start) || 0;
  return Number((audioStart + (Number(milliseconds) / 1000)).toFixed(6));
}

export function parseRegionTiming(data, region) {
  const utterances = [];
  const tokens = [];
  for (const segment of data.transcription ?? []) {
    const start = absoluteOffset(region, segment?.offsets?.from);
    const end = absoluteOffset(region, segment?.offsets?.to);
    const text = String(segment?.text ?? "").trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) {
      utterances.push({ start, end, text });
    }
    for (const token of segment?.tokens ?? []) {
      const tokenText = String(token?.text ?? "");
      if (!tokenText || /^\[_.*\]$/u.test(tokenText) || /^<\|.*\|>$/u.test(tokenText)) continue;
      const tokenStart = absoluteOffset(region, token?.offsets?.from);
      const rawEnd = absoluteOffset(region, token?.offsets?.to);
      if (!Number.isFinite(tokenStart) || !Number.isFinite(rawEnd)) continue;
      tokens.push({
        start: tokenStart,
        end: Math.max(rawEnd, Number((tokenStart + 0.02).toFixed(6))),
        text: tokenText,
        probability: Math.max(0, Math.min(1, Number(token?.p) || 0)),
      });
    }
  }
  return { utterances, tokens };
}

export function whisperArguments({ modelPath, audioPaths, vadModelPath, language, useGpu = true, prompt = "", threads = null }) {
  const args = [
    "-m", modelPath,
    "-l", language,
    "--vad",
    "-vm", vadModelPath,
    "-vsd", "500",
    "-vp", "100",
    "-ojf",
    "-np",
    ...audioPaths,
  ];
  // A short initial prompt with the speaker's vocabulary steers spelling of
  // names and terms; whisper-cli applies it at the start of every region.
  const text = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (text) args.unshift("--prompt", text);
  if (Number.isInteger(threads) && threads > 0) args.unshift("-t", String(threads));
  if (!useGpu) args.unshift("-ng");
  return args;
}

async function mapConcurrent(items, maximumConcurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try { results[index] = await callback(items[index], index); }
      catch (error) { failure ??= error; }
    }
  };
  // In-flight extractors must finish (or acknowledge cancellation) before the
  // caller removes their temporary directory, particularly on Windows.
  await Promise.all(Array.from({ length: Math.min(maximumConcurrency, items.length) }, worker));
  if (failure) throw failure;
  return results;
}

function dominantLanguage(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.language, (counts.get(item.language) ?? 0) + 1);
  return [...counts.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] ?? "unknown";
}

function languageDetectionJob(jobs) {
  return jobs.reduce((best, job) => {
    const duration = job.region.audioEnd - job.region.audioStart;
    const bestDuration = best.region.audioEnd - best.region.audioStart;
    return duration > bestDuration ? job : best;
  });
}

export async function transcribeMedia(inputPath, {
  regions = [],
  modelPath,
  vadModelPath,
  language = "auto",
  useGpu = true,
  prompt = "",
  threads = null,
  signal,
  ffmpegCommand = "ffmpeg",
  whisperCommand = "whisper-cli",
  runCommand = run,
  extractionConcurrency = 4,
  onProgress = null,
  progressIntervalMs = 1000,
} = {}) {
  // Callers own where models live (CLI: .models/, desktop: its runtime directory).
  if (!modelPath || !vadModelPath) throw new Error("Speech analysis needs a Whisper model and a VAD model path.");
  const resolvedModel = path.resolve(modelPath);
  const resolvedVadModel = path.resolve(vadModelPath);
  try {
    await access(resolvedModel);
  } catch {
    throw new Error(`Whisper model not found: ${resolvedModel}. See README.md for setup instructions.`);
  }
  try {
    await access(resolvedVadModel);
  } catch {
    throw new Error(`Whisper VAD model not found: ${resolvedVadModel}. See README.md for setup instructions.`);
  }

  const preparedRegions = regions
    .map((region) => ({
      start: Number(region?.start),
      end: Number(region?.end),
      audioStart: Number(region?.audioStart ?? region?.start),
      audioEnd: Number(region?.audioEnd ?? region?.end),
    }))
    .filter((region) => Number.isFinite(region.start)
      && Number.isFinite(region.end)
      && Number.isFinite(region.audioStart)
      && Number.isFinite(region.audioEnd)
      && region.end > region.start
      && region.audioEnd > region.audioStart);
  if (!preparedRegions.length) return { language: "unknown", segments: [], text: "", utterances: [], tokens: [] };

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "roughcut-transcribe-"));
  const audioPath = path.join(temporaryDirectory, "audio.wav");

  try {
    await runCommand(ffmpegCommand, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-map", "0:a:0", "-vn",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      audioPath,
    ], { signal });

    const jobs = await mapConcurrent(preparedRegions, Math.max(1, extractionConcurrency), async (region, index) => {
      const regionPath = path.join(temporaryDirectory, `region-${String(index).padStart(5, "0")}.wav`);
      await runCommand(ffmpegCommand, [
        "-y", "-hide_banner", "-loglevel", "error",
        "-ss", String(region.audioStart),
        "-t", String(region.audioEnd - region.audioStart),
        "-i", audioPath,
        "-c:a", "pcm_s16le",
        regionPath,
      ], { signal });
      return { region, regionPath };
    });

    let gpuEnabled = useGpu;
    const transcribeJobs = async (targetJobs, targetLanguage) => {
      const invoke = async () => {
        await runCommand(whisperCommand, whisperArguments({
          modelPath: resolvedModel,
          audioPaths: targetJobs.map((job) => job.regionPath),
          vadModelPath: resolvedVadModel,
          language: targetLanguage,
          useGpu: gpuEnabled,
          prompt,
          threads,
        }), { signal });
        await Promise.all(targetJobs.map((job) => access(`${job.regionPath}.json`)));
      };
      try {
        await invoke();
      } catch (error) {
        if (!gpuEnabled || signal?.aborted) throw error;
        gpuEnabled = false;
        await invoke();
      }
    };

    // whisper-cli runs silently (-np) and writes one JSON per region as it
    // finishes, so finished regions are counted from the directory.
    const reportProgress = async () => {
      const names = await readdir(temporaryDirectory).catch(() => []);
      onProgress?.({ completed: names.filter((name) => name.endsWith(".wav.json")).length, total: jobs.length });
    };
    const progressTimer = onProgress ? setInterval(reportProgress, progressIntervalMs) : null;
    progressTimer?.unref?.();
    onProgress?.({ completed: 0, total: jobs.length });

    let resolvedLanguage = language;
    let detectedJob = null;
    try {
    if (language === "auto") {
      detectedJob = languageDetectionJob(jobs);
      await transcribeJobs([detectedJob], "auto");
      const detection = JSON.parse(await readFile(`${detectedJob.regionPath}.json`, "utf8"));
      resolvedLanguage = detection.result?.language ?? "auto";
    }

    const remainingJobs = detectedJob ? jobs.filter((job) => job !== detectedJob) : jobs;
    if (remainingJobs.length) await transcribeJobs(remainingJobs, resolvedLanguage);
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
    onProgress?.({ completed: jobs.length, total: jobs.length });

    const parsed = await Promise.all(jobs.map(async ({ region, regionPath }) => {
      const data = JSON.parse(await readFile(`${regionPath}.json`, "utf8"));
      return {
        segment: parseRegionTranscription(data, region),
        timing: parseRegionTiming(data, region),
        bounds: { start: region.audioStart, end: region.audioEnd },
      };
    }));
    const segments = parsed.filter((item) => item.segment).map((item) => {
      const words = alignWordTiming(item.segment, item.timing.tokens, item.bounds);
      return words.length ? { ...item.segment, words, wordTimingBounds: item.bounds } : item.segment;
    });
    return {
      language: resolvedLanguage === "auto" ? dominantLanguage(segments) : resolvedLanguage,
      segments: segments.map(({ language: _language, ...segment }) => segment),
      text: segments.map((segment) => segment.text).join(" "),
      utterances: parsed.flatMap((item) => item.timing.utterances),
      tokens: parsed.flatMap((item) => item.timing.tokens),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export { parseTranscription };
