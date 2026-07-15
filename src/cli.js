#!/usr/bin/env node

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFcpxml } from "./fcpxml.js";
import { detectSilences, probeMedia } from "./media.js";
import { chooseProjectResolution } from "./resolution.js";
import { buildSegments } from "./segments.js";

const HELP = `roughcut — create a silence-cut Final Cut Pro timeline

Usage:
  roughcut <video-file> [options]

Options:
  -o, --output <path>          FCPXML output path
  --threshold <dB>            Silence threshold (default: -35)
  --minimum-silence <seconds> Minimum silence to shorten (default: 0.7)
  --keep-pause <seconds>      Pause retained inside each cut (default: 0.18)
  --project-resolution <size> Use source, 4k, or full-hd without prompting
  --no-report                 Do not write the JSON cut report
  -h, --help                  Show this help

Example:
  roughcut recording.mov --threshold -35 --minimum-silence 0.7 --keep-pause 0.18
`;

function readNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number.`);
  return number;
}

export function parseArgs(argv) {
  const options = { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18, report: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--no-report") options.report = false;
    else if (argument === "-o" || argument === "--output") {
      options.output = argv[++index];
      if (!options.output) throw new Error(`${argument} requires a path.`);
    }
    else if (argument === "--threshold") options.thresholdDb = readNumber(argv[++index], "--threshold");
    else if (argument === "--minimum-silence") options.minimumSilence = readNumber(argv[++index], "--minimum-silence");
    else if (argument === "--keep-pause") options.keepPause = readNumber(argv[++index], "--keep-pause");
    else if (argument === "--project-resolution") {
      options.projectResolution = argv[++index];
      if (!options.projectResolution) throw new Error(`${argument} requires a value.`);
    }
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (!options.input) options.input = argument;
    else throw new Error(`Unexpected argument: ${argument}`);
  }

  if (options.minimumSilence <= 0) throw new Error("--minimum-silence must be greater than zero.");
  if (options.keepPause < 0) throw new Error("--keep-pause cannot be negative.");
  if (options.keepPause >= options.minimumSilence) {
    throw new Error("--keep-pause must be shorter than --minimum-silence.");
  }
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
  const outputPath = path.resolve(options.output ?? path.join(parsed.dir, `${parsed.name}.roughcut.fcpxml`));
  const outputParsed = path.parse(outputPath);
  const reportBase = outputParsed.name.replace(/\.roughcut$/i, "");
  const reportPath = path.join(outputParsed.dir, `${reportBase}.roughcut.json`);

  console.log(`Reading ${parsed.base}…`);
  const media = await probeMedia(inputPath);
  const projectResolution = await chooseProjectResolution(media, options.projectResolution);
  console.log(`Project resolution: ${projectResolution.width}x${projectResolution.height}`);
  console.log("Analysing audio…");
  const silences = await detectSilences(inputPath, options);
  const segments = buildSegments(silences, media.duration, media.frameRate, options.keepPause);
  if (segments.keeps.length === 0) throw new Error("The whole file was detected as silence; no timeline was created.");

  const fcpxml = createFcpxml({
    inputPath,
    clipName: parsed.base,
    compoundName: `${parsed.name} — Source`,
    projectName: `${parsed.name} — Rough Cut`,
    media,
    projectResolution,
    keeps: segments.keeps,
  });
  await writeFile(outputPath, fcpxml, "utf8");

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
    },
    originalDurationSeconds: media.duration,
    roughcutDurationSeconds: seconds(segments.durationFrames - removedFrames, media.frameRate),
    removedDurationSeconds: seconds(removedFrames, media.frameRate),
    cuts: segments.removals.map((item) => ({
      startSeconds: seconds(item.startFrame, media.frameRate),
      endSeconds: seconds(item.endFrame, media.frameRate),
      durationSeconds: seconds(item.endFrame - item.startFrame, media.frameRate),
    })),
  };
  if (options.report) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Detected ${silences.length} silence${silences.length === 1 ? "" : "s"}; created ${segments.removals.length} cut${segments.removals.length === 1 ? "" : "s"}.`);
  console.log(`Removed ${report.removedDurationSeconds.toFixed(1)}s from ${report.originalDurationSeconds.toFixed(1)}s.`);
  console.log(`FCPXML: ${outputPath}`);
  if (options.report) console.log(`Report:  ${reportPath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
