#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectSilences, probeMedia } from "./media.js";
import { buildSoundIslands, detectNonVerbalSounds, nonVerbalSilenceSettings } from "./nonverbal.js";
import { chooseProjectResolution } from "./resolution.js";
import { addTextCuts, buildSegments, buildSpeechRegions, transcriptionSilenceSettings } from "./segments.js";
import { detectTextEdits } from "./text-edits.js";
import { DEFAULT_VAD_MODEL, DEFAULT_WHISPER_MODEL, transcribeMedia } from "./transcribe.js";
import { createTimelineDocument, timelineExportFor } from "./timeline-export.js";

const HELP = `openroughcut — create a silence-cut editable timeline

Usage:
  openroughcut <video-file> [options]

Options:
  -o, --output <path>          Timeline output path
  --format <editor>            final-cut, premiere, or resolve (default: final-cut)
  --threshold <dB>            Silence threshold (default: -35)
  --minimum-silence <seconds> Minimum silence to shorten (default: 0.7)
  --keep-pause <seconds>      Pause retained inside each cut (default: 0.18)
  --project-resolution <size> Use source, 4k, full-hd, vertical-4k, or vertical-full-hd
  --transcribe                Detect strong duplicate takes and false starts
  --remove-non-verbal         Automatically cut isolated sounds without words
  --whisper-model <path>      Whisper GGML model (default: .models/ggml-base.bin)
  --whisper-vad-model <path>  Silero VAD model for isolated speech regions
  --language <code>           Spoken language or auto (default: auto)
  --text-confidence <number>  Auto-remove threshold from 0 to 1 (default: 0.9)
  --text-suggestions-only     Report text candidates without applying them
  --no-report                 Do not write the JSON cut report
  -h, --help                  Show this help

Example:
  openroughcut recording.mov --threshold -35 --minimum-silence 0.7 --keep-pause 0.18
`;

function readNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`);
  return number;
}

export function parseArgs(argv) {
  const options = {
    thresholdDb: -35,
    minimumSilence: 0.7,
    keepPause: 0.18,
    report: true,
    language: "auto",
    textConfidence: 0.9,
    applyTextEdits: true,
    format: "final-cut",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--no-report") options.report = false;
    else if (argument === "--transcribe") options.transcribe = true;
    else if (argument === "--remove-non-verbal") options.removeNonVerbal = true;
    else if (argument === "--text-suggestions-only") {
      options.transcribe = true;
      options.applyTextEdits = false;
    }
    else if (argument === "-o" || argument === "--output") {
      options.output = argv[++index];
      if (!options.output) throw new Error(`${argument} requires a path.`);
    }
    else if (argument === "--threshold") options.thresholdDb = readNumber(argv[++index], "--threshold");
    else if (argument === "--minimum-silence") options.minimumSilence = readNumber(argv[++index], "--minimum-silence");
    else if (argument === "--keep-pause") options.keepPause = readNumber(argv[++index], "--keep-pause");
    else if (argument === "--format") {
      options.format = argv[++index];
      if (!options.format) throw new Error(`${argument} requires final-cut, premiere, or resolve.`);
    }
    else if (argument === "--project-resolution") {
      options.projectResolution = argv[++index];
      if (!options.projectResolution) throw new Error(`${argument} requires a value.`);
    }
    else if (argument === "--whisper-model") {
      options.whisperModel = argv[++index];
      if (!options.whisperModel) throw new Error(`${argument} requires a path.`);
    }
    else if (argument === "--whisper-vad-model") {
      options.whisperVadModel = argv[++index];
      if (!options.whisperVadModel) throw new Error(`${argument} requires a path.`);
    }
    else if (argument === "--language") {
      options.language = argv[++index];
      if (!options.language) throw new Error(`${argument} requires a language code or auto.`);
    }
    else if (argument === "--text-confidence") options.textConfidence = readNumber(argv[++index], "--text-confidence");
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (!options.input) options.input = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }

  if (options.minimumSilence <= 0) throw new Error("--minimum-silence must be greater than zero.");
  if (options.keepPause < 0) throw new Error("--keep-pause cannot be negative.");
  if (options.keepPause >= options.minimumSilence) {
    throw new Error("--keep-pause must be shorter than --minimum-silence.");
  }
  if (options.textConfidence < 0 || options.textConfidence > 1) {
    throw new Error("--text-confidence must be between zero and one.");
  }
  timelineExportFor(options.format);
  return options;
}

function seconds(frames, frameRate) {
  return frames * frameRate.denominator / frameRate.numerator;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    console.log(HELP);
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const inputPath = path.resolve(options.input);
  await access(inputPath);
  const parsed = path.parse(inputPath);
  const exportTarget = timelineExportFor(options.format);
  const outputPath = path.resolve(options.output ?? path.join(parsed.dir, `${parsed.name}.roughcut.${exportTarget.extension}`));
  const outputParsed = path.parse(outputPath);
  const reportBase = outputParsed.name.replace(/\.roughcut$/i, "");
  const reportPath = path.join(outputParsed.dir, `${reportBase}.roughcut.json`);

  console.log(`Reading ${parsed.base}…`);
  const media = await probeMedia(inputPath);
  const projectResolution = await chooseProjectResolution(media, options.projectResolution);
  console.log(`Project resolution: ${projectResolution.width}x${projectResolution.height}`);
  console.log("Analysing audio…");
  const silences = await detectSilences(inputPath, options);
  let transcript = null;
  let textEdits = { candidates: [], applied: [] };
  let nonVerbal = { candidates: [], applied: [] };
  const speechAnalysisEnabled = options.transcribe || options.removeNonVerbal;
  if (speechAnalysisEnabled) {
    console.log("Transcribing locally with Whisper…");
    const transcriptSettings = transcriptionSilenceSettings(options);
    const transcriptSilences = transcriptSettings.minimumSilence === options.minimumSilence
      ? silences
      : await detectSilences(inputPath, transcriptSettings);
    transcript = await transcribeMedia(inputPath, {
      regions: buildSpeechRegions(transcriptSilences, media.duration, {
        minimumSpeechSeconds: options.removeNonVerbal ? 0.02 : 0.3,
      }),
      modelPath: options.whisperModel ?? DEFAULT_WHISPER_MODEL,
      vadModelPath: options.whisperVadModel ?? DEFAULT_VAD_MODEL,
      language: options.language,
    });
    if (options.transcribe) textEdits = detectTextEdits(transcript.segments, { autoConfidence: options.textConfidence });
    if (options.removeNonVerbal) {
      const soundSettings = nonVerbalSilenceSettings(options);
      const soundSilences = soundSettings.minimumSilence === transcriptSettings.minimumSilence
        ? transcriptSilences
        : await detectSilences(inputPath, soundSettings);
      nonVerbal = detectNonVerbalSounds(buildSoundIslands(soundSilences, media.duration), {
        tokens: transcript.tokens,
        utterances: transcript.utterances,
      });
    }
    console.log(`Transcript language: ${transcript.language}; found ${textEdits.candidates.length} text candidate${textEdits.candidates.length === 1 ? "" : "s"} and ${nonVerbal.candidates.length} non-word sound${nonVerbal.candidates.length === 1 ? "" : "s"}.`);
  }

  const silenceSegments = buildSegments([
    ...silences,
    ...nonVerbal.applied.map((item) => ({ start: item.start, end: item.end })),
  ], media.duration, media.frameRate, options.keepPause);
  const appliedTextEdits = options.applyTextEdits ? textEdits.applied : [];
  const segments = addTextCuts(silenceSegments, appliedTextEdits, media.frameRate);
  if (segments.keeps.length === 0) throw new Error("The whole file was detected as silence; no timeline was created.");

  const document = createTimelineDocument(options.format, {
    inputPath,
    clipName: parsed.base,
    compoundName: `${parsed.name} — Source`,
    projectName: `${parsed.name} — Rough Cut`,
    media,
    projectResolution,
    keeps: segments.keeps,
  });
  await writeFile(outputPath, document, "utf8");

  const removedFrames = segments.removals.reduce((total, item) => total + item.endFrame - item.startFrame, 0);
  const report = {
    input: inputPath,
    settings: {
      thresholdDb: options.thresholdDb,
      minimumSilenceSeconds: options.minimumSilence,
      keepPauseSeconds: options.keepPause,
      projectResolution: {
        choice: projectResolution.choice,
        width: projectResolution.width,
        height: projectResolution.height,
      },
      exportFormat: options.format,
      transcription: speechAnalysisEnabled ? {
        language: options.language,
        model: path.resolve(options.whisperModel ?? DEFAULT_WHISPER_MODEL),
        vadModel: path.resolve(options.whisperVadModel ?? DEFAULT_VAD_MODEL),
        confidenceThreshold: options.textConfidence,
        applyEdits: options.applyTextEdits,
        removeNonVerbal: options.removeNonVerbal === true,
      } : null,
    },
    originalDurationSeconds: media.duration,
    roughcutDurationSeconds: seconds(segments.durationFrames - removedFrames, media.frameRate),
    removedDurationSeconds: seconds(removedFrames, media.frameRate),
    cuts: segments.removals.map((item) => ({
      startSeconds: seconds(item.startFrame, media.frameRate),
      endSeconds: seconds(item.endFrame, media.frameRate),
      durationSeconds: seconds(item.endFrame - item.startFrame, media.frameRate),
    })),
    transcript: transcript ? {
      language: transcript.language,
      text: transcript.text,
      segments: options.transcribe ? transcript.segments : [],
    } : null,
    textEdits: speechAnalysisEnabled ? {
      applied: appliedTextEdits,
      suggestions: textEdits.candidates.filter((item) => !appliedTextEdits.includes(item)),
      nonVerbal: nonVerbal.candidates,
    } : null,
  };
  if (options.report) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Detected ${silences.length} silence${silences.length === 1 ? "" : "s"}; created ${segments.removals.length} cut${segments.removals.length === 1 ? "" : "s"}.`);
  console.log(`Removed ${report.removedDurationSeconds.toFixed(1)}s from ${report.originalDurationSeconds.toFixed(1)}s.`);
  if (options.transcribe) {
    console.log(`Applied ${appliedTextEdits.length} high-confidence text edit${appliedTextEdits.length === 1 ? "" : "s"}; review all candidates in the JSON report.`);
  }
  if (options.removeNonVerbal) console.log(`Applied ${nonVerbal.applied.length} isolated non-word sound cut${nonVerbal.applied.length === 1 ? "" : "s"}.`);
  console.log(`${exportTarget.shortLabel}: ${outputPath}`);
  if (options.format === "resolve") console.log(`Resolve: set the imported timeline to ${projectResolution.width}x${projectResolution.height}.`);
  if (options.report) console.log(`Report:  ${reportPath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
