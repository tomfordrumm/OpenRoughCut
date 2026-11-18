#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "@openroughcut/core";
import { assertReviewPacket, assertSameSource, buildReviewPacket, sourceFingerprint } from "@openroughcut/core/agent-review.js";
import { assertDuplicateMode, DEFAULT_DUPLICATE_MODE } from "@openroughcut/core/duplicate-modes.js";
import { probeMedia } from "@openroughcut/core/media.js";
import { timelineExportFor } from "@openroughcut/core/timeline-export.js";
import { chooseProjectResolution } from "./resolution-prompt.js";

// Models downloaded into the repository's .models directory (see README).
const MODELS_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".models");
export const DEFAULT_WHISPER_MODEL = path.join(MODELS_DIRECTORY, "ggml-base.bin");
export const DEFAULT_VAD_MODEL = path.join(MODELS_DIRECTORY, "ggml-silero-v6.2.0.bin");

export const HELP = `openroughcut — create a silence-cut editable timeline

Usage:
  openroughcut <video-file> [options]

Agent review (for an LLM agent driving the CLI):
  openroughcut <video-file> --review <review.json>     cut, then write a review packet
  openroughcut <video-file> --decisions <decisions.json>
                              rebuild the timeline from the packet's transcript and
                              the agent's keep/remove/cut decisions (no Whisper rerun)

Options:
  -o, --output <path>          Timeline output path
  --format <editor>            final-cut, premiere, resolve, or mp4 to render the
                              cut video itself (default: final-cut)
  --threshold <dB>            Silence threshold (default: -35)
  --minimum-silence <seconds> Minimum silence to shorten (default: 0.7)
  --keep-pause <seconds>      Pause retained inside each cut (default: 0.18)
  --project-resolution <size> Use source, 4k, full-hd, vertical-4k, or vertical-full-hd
  --transcribe                Transcribe and detect duplicates with the selected mode
  --duplicate-mode <mode>     last-take (default) or rules; enables transcription
  --remove-non-verbal         Automatically cut isolated sounds without words
  --whisper-model <path>      Whisper GGML model (default: .models/ggml-base.bin)
  --whisper-vad-model <path>  Silero VAD model for isolated speech regions
  --language <code>           Spoken language or auto (default: auto)
  --text-confidence <number>  last-take/rules auto-remove threshold from 0 to 1 (default: 0.9)
  --text-suggestions-only     Run selected detector; report candidates without speech removals
  --review <path>             Also write an agent review packet (enables transcription)
  --decisions <path>          Apply an agent decisions file to its review packet
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
    duplicateMode: DEFAULT_DUPLICATE_MODE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--no-report") options.report = false;
    else if (argument === "--duplicate-mode") {
      options.duplicateMode = argv[++index];
      if (!options.duplicateMode) throw new Error("--duplicate-mode requires last-take or rules.");
      assertDuplicateMode(options.duplicateMode);
      options.transcribe = true;
      options.duplicateModeExplicit = true;
    }
    else if (argument === "--transcribe") options.transcribe = true;
    else if (argument === "--review" || argument === "--decisions") {
      const key = argument === "--review" ? "review" : "decisions";
      options[key] = argv[++index];
      if (!options[key]) throw new Error(`${argument} requires a path.`);
      options.transcribe = true;
    }
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
      if (!options.format) throw new Error(`${argument} requires final-cut, premiere, resolve, or mp4.`);
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
  if (options.decisions && options.review) throw new Error("--decisions applies an existing review; it cannot also write one.");
  if (options.decisions && options.duplicateModeExplicit) throw new Error("--decisions uses the duplicate mode recorded in its review packet.");
  if (options.decisions && !options.applyTextEdits) throw new Error("--decisions cannot be combined with --text-suggestions-only.");
  timelineExportFor(options.format);
  return options;
}

const shellQuote = (value) => (/^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

// The command that applies decisions with the same analysis settings as this run.
export function decisionsCommand(argv, decisionsPath = "<decisions.json>") {
  const kept = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--review" || argv[index] === "--duplicate-mode") { index += 1; continue; }
    if (argv[index] === "--transcribe" || argv[index] === "--text-suggestions-only") continue;
    kept.push(argv[index]);
  }
  return ["openroughcut", ...kept, "--decisions"].map(shellQuote).join(" ") + ` ${decisionsPath}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Prints stage changes and every tenth percent of long steps.
function progressLogger(log) {
  let lastStage = null, lastPercent = -1;
  return ({ stage, message, percent }) => {
    if (stage !== lastStage) {
      lastStage = stage;
      lastPercent = percent ?? -1;
      log(message);
    } else if (percent === null) log(message);
    else if (percent >= lastPercent + 10) {
      lastPercent = percent;
      log(message);
    }
  };
}

// `pipeline` and `dependencies` exist for tests: the CLI always runs the core
// pipeline; tests may observe it or replace media access, probing,
// transcription and file writes.
export async function runCli(argv, { signal, log = console.log, dependencies = {}, pipeline = core } = {}) {
  const io = { access, readFile, writeFile, fingerprintSource: sourceFingerprint, probeMedia, chooseProjectResolution, ...dependencies };
  const options = parseArgs(argv);
  if (options.help || !options.input) {
    log(HELP);
    return { exitCode: options.help ? 0 : 1 };
  }
  signal?.throwIfAborted();

  const inputPath = path.resolve(options.input);
  await io.access(inputPath);
  const parsed = path.parse(inputPath);
  const exportTarget = timelineExportFor(options.format);
  const outputPath = path.resolve(options.output ?? path.join(parsed.dir, `${parsed.name}.roughcut.${exportTarget.extension}`));
  const outputParsed = path.parse(outputPath);
  const reportPath = path.join(outputParsed.dir, `${outputParsed.name.replace(/\.roughcut$/i, "")}.roughcut.json`);
  const reviewPath = options.review ? path.resolve(options.review) : null;

  const agent = options.decisions ? await readDecisions(path.resolve(options.decisions)) : null;
  const speech = agent ? pipeline.applyDecisions(agent.packet, agent.decisions) : null;
  if (speech?.duplicateMode) options.duplicateMode = speech.duplicateMode;

  log(`Reading ${parsed.base}…`);
  const media = await io.probeMedia(inputPath, { signal });
  // Only an agent review needs to know which recording this is.
  const fingerprint = agent || reviewPath ? await io.fingerprintSource(inputPath) : null;
  if (agent) assertSameSource(agent.packet, fingerprint, media.duration, `The review packet ${agent.reviewPath}`);
  const projectResolution = await io.chooseProjectResolution(media, options.projectResolution, { signal });
  log(`Project resolution: ${projectResolution.width}x${projectResolution.height}`);

  const models = { whisper: options.whisperModel ?? DEFAULT_WHISPER_MODEL, vad: options.whisperVadModel ?? DEFAULT_VAD_MODEL };
  const settings = {
    thresholdDb: options.thresholdDb,
    minimumSilence: options.minimumSilence,
    keepPause: options.keepPause,
    transcribe: options.transcribe === true,
    removeNonVerbal: options.removeNonVerbal === true,
    duplicateMode: options.duplicateMode,
    textConfidence: options.textConfidence,
    applyTextEdits: options.applyTextEdits,
    language: options.language,
  };
  const analysis = await pipeline.analyze(inputPath, settings, { signal, media, models, speech, onProgress: progressLogger(log), dependencies });
  const { textEdits, nonVerbal, appliedTextEdits, transcription } = analysis;
  if (agent) {
    const { kept, removed, cut } = textEdits.summary.agentDecisions;
    log(`Applied agent decisions: ${kept.length} kept, ${plural(removed.length, "suggestion")} applied, ${plural(cut.length, "new cut")}.`);
  }
  if (transcription) log(`Transcript language: ${transcription.language}; found ${plural(textEdits.candidates.length, "text candidate")} and ${plural(nonVerbal.candidates.length, "non-word sound")}.`);

  const plan = pipeline.buildPlan(analysis, []);
  if (plan.keeps.length === 0) throw new Error("The whole file was detected as silence; no timeline was created.");
  if (exportTarget.renders) log(`Rendering ${plural(plan.keeps.length, "kept part")} to ${path.basename(outputPath)}…`);
  let reported = -1;
  await pipeline.exportPlan(plan, {
    format: options.format, inputPath, outputPath, media, projectResolution, signal, dependencies,
    onProgress: ({ percent }) => { if (percent >= reported + 10 || percent === 100) { reported = percent; log(`Rendering · ${percent}%`); } },
  });

  const report = pipeline.createReport(analysis, plan, { exportFormat: options.format, projectResolution, models });
  if (options.report) await io.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (reviewPath) {
    const packet = buildReviewPacket({
      inputPath, fingerprint, media, transcript: transcription, textEdits, applied: appliedTextEdits, reviewPath, outputPath,
      applyCommand: decisionsCommand(argv),
      settings: { duplicateMode: options.duplicateMode, textConfidence: options.textConfidence },
    });
    await io.writeFile(reviewPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  }

  log(`Detected ${plural(analysis.silences.length, "silence")}; created ${plural(plan.removals.length, "cut")}.`);
  log(`Removed ${report.removedDurationSeconds.toFixed(1)}s from ${report.originalDurationSeconds.toFixed(1)}s.`);
  if (options.transcribe) log(`Applied ${plural(appliedTextEdits.length, "automatic text edit")}; review all candidates in the JSON report.`);
  if (options.removeNonVerbal) log(`Applied ${plural(nonVerbal.applied.length, "isolated non-word sound cut")}.`);
  log(`${exportTarget.shortLabel}: ${outputPath}`);
  if (options.format === "resolve") log(`Resolve: set the imported timeline to ${projectResolution.width}x${projectResolution.height}.`);
  if (options.report) log(`Report:  ${reportPath}`);
  if (reviewPath) log(`Review:  ${reviewPath}\nAn agent can read it, write decisions in the decisionsTemplate shape, then run: ${decisionsCommand(argv)}`);
  if (options.transcribe) log("Review timing, retained meaning and edited audio before accepting the timeline.");
  return { exitCode: 0, report, outputPath, reportPath: options.report ? reportPath : null, reviewPath };

  async function readDecisions(decisionsPath) {
    const readJson = async (file, label) => {
      try { return JSON.parse(await io.readFile(file, "utf8")); }
      catch (error) { throw new Error(`Cannot read ${label} ${file}: ${error.message}`); }
    };
    const decisions = await readJson(decisionsPath, "decisions file");
    if (typeof decisions?.review !== "string" || !decisions.review) throw new Error("Invalid decisions: `review` must be the path of the review packet.");
    const reviewPath = path.resolve(path.dirname(decisionsPath), decisions.review);
    const packet = assertReviewPacket(await readJson(reviewPath, "review packet"));
    return { decisions, packet, reviewPath };
  }
}

// SIGINT/SIGTERM cancel child work and wait for the owned runtime to stop.
export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  let interrupted = null;
  const onInterrupt = (name) => { interrupted ??= name; controller.abort(); };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    const result = await runCli(argv, { signal: controller.signal });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`Error: ${controller.signal.aborted ? "Operation cancelled." : error.message}`);
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function launchedDirectly() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; } // Imports from stdin/eval do not have an entry file.
}
if (launchedDirectly()) await main();
