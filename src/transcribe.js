import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_WHISPER_MODEL = path.join(PROJECT_ROOT, ".models", "ggml-base.bin");
export const DEFAULT_VAD_MODEL = path.join(PROJECT_ROOT, ".models", "ggml-silero-v6.2.0.bin");

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

export async function transcribeMedia(inputPath, {
  modelPath = DEFAULT_WHISPER_MODEL,
  vadModelPath = DEFAULT_VAD_MODEL,
  language = "auto",
  useGpu = true,
  signal,
  ffmpegCommand = "ffmpeg",
  whisperCommand = "whisper-cli",
} = {}) {
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

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "roughcut-transcribe-"));
  const audioPath = path.join(temporaryDirectory, "audio.wav");
  const outputBase = path.join(temporaryDirectory, "transcript");

  try {
    await run(ffmpegCommand, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inputPath,
      "-map", "0:a:0", "-vn",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      audioPath,
    ], { signal });

    const whisperArgs = [
      "-m", resolvedModel,
      "-f", audioPath,
      "-l", language,
      "--vad",
      "-vm", resolvedVadModel,
      "-vsd", "500",
      "-vp", "100",
      "-ojf",
      "-of", outputBase,
      "-np",
    ];
    if (!useGpu) whisperArgs.unshift("-ng");
    await run(whisperCommand, whisperArgs, { signal });

    const data = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
    return parseTranscription(data);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export { parseTranscription };
