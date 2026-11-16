// The one OpenRoughCut pipeline. The CLI, the desktop app and any server worker
// call these functions; none of them re-assembles the analysis steps.
//
//   analyze(input, settings, { signal, onProgress })  → analysis (cuts + candidates)
//   applyDecisions(reviewPacket, decisions)            → speech decisions for analyze({ speech })
//   buildPlan(analysis, manualOverrides)               → final plan (keeps/removals in frames)
//   exportPlan(plan, { format, outputPath, … })        → timeline document or rendered video
//   createReport(analysis, plan, …)                    → JSON cut report
//
// Nothing here prints, prompts, exits the process or knows about Electron.
// Cancellation is an AbortSignal; progress is a callback.
import { randomUUID } from "node:crypto";
import { writeFile as writeFileToDisk } from "node:fs/promises";
import path from "node:path";
import { applyAgentDecisions, assertReviewPacket } from "./agent-review.js";
import { assertDuplicateMode, DEFAULT_DUPLICATE_MODE, LAST_TAKE_DUPLICATE_MODE, usesTextConfidence } from "./duplicate-modes.js";
import { buildReviewedPlan } from "./edit-cleanup.js";
import { detectLastTakeEdits } from "./last-take.js";
import { detectSilences, probeMedia } from "./media.js";
import { buildSoundIslands, detectNonVerbalSounds, nonVerbalSilenceSettings } from "./nonverbal.js";
import { buildPlan } from "./plan.js";
import { keepsToSeconds, renderVideo } from "./render-video.js";
import { addTextCuts, buildSegments, buildSpeechRegions, secondsToFrames, transcriptionSilenceSettings } from "./segments.js";
import { detectTextEdits } from "./text-edits.js";
import { createTimelineDocument, timelineExportFor } from "./timeline-export.js";
import { transcribeMedia } from "./transcribe.js";

export { buildPlan };

export const DEFAULT_ANALYSIS_SETTINGS = Object.freeze({
  thresholdDb: -35,
  minimumSilence: 0.7,
  keepPause: 0.18,
  /** Transcribe and detect repeated takes with `duplicateMode`. */
  transcribe: false,
  /** Cut isolated sounds without words (needs Whisper as well). */
  removeNonVerbal: false,
  duplicateMode: DEFAULT_DUPLICATE_MODE,
  textConfidence: 0.9,
  /** false: detect takes but only suggest them; nothing spoken is cut. */
  applyTextEdits: true,
  language: "auto",
});

const EMPTY_EDITS = Object.freeze({ candidates: [], applied: [] });

/** Defaults plus validation shared by every front end. Throws on invalid values. */
export function normalizeAnalysisSettings(input = {}) {
  const merged = { ...DEFAULT_ANALYSIS_SETTINGS };
  for (const key of Object.keys(DEFAULT_ANALYSIS_SETTINGS)) {
    if (input?.[key] !== undefined && input[key] !== null) merged[key] = input[key];
  }
  const thresholdDb = Number(merged.thresholdDb);
  const minimumSilence = Number(merged.minimumSilence);
  const keepPause = Number(merged.keepPause);
  const textConfidence = Number(merged.textConfidence);
  if (!Number.isFinite(thresholdDb) || thresholdDb > 0 || thresholdDb < -100) throw new Error("Threshold must be between -100 and 0 dB.");
  if (!Number.isFinite(minimumSilence) || minimumSilence <= 0) throw new Error("Minimum silence must be greater than zero.");
  if (!Number.isFinite(keepPause) || keepPause < 0 || keepPause >= minimumSilence) throw new Error("Pause to keep must be non-negative and shorter than minimum silence.");
  if (!Number.isFinite(textConfidence) || textConfidence < 0 || textConfidence > 1) throw new Error("Text confidence must be between zero and one.");
  if (typeof merged.language !== "string" || !merged.language) throw new Error("Language must be a language code or auto.");
  return {
    thresholdDb,
    minimumSilence,
    keepPause,
    transcribe: merged.transcribe === true,
    removeNonVerbal: merged.removeNonVerbal === true,
    duplicateMode: assertDuplicateMode(merged.duplicateMode),
    textConfidence,
    applyTextEdits: merged.applyTextEdits !== false,
    language: merged.language,
  };
}

/**
 * Turn an agent's decisions on a review packet into the speech input of
 * `analyze`: the packet's transcript (Whisper is not run again) and the
 * resulting text edits. Silences still come from the audio.
 */
export function applyDecisions(reviewPacket, decisions) {
  assertReviewPacket(reviewPacket);
  return {
    transcript: reviewPacket.transcript,
    textEdits: applyAgentDecisions(reviewPacket, decisions),
    duplicateMode: reviewPacket.settings?.duplicateMode ?? null,
  };
}

/**
 * Measure the recording and decide the automatic cuts.
 *
 * @param inputPath  source media path
 * @param settingsInput  see DEFAULT_ANALYSIS_SETTINGS
 * @param options.signal  AbortSignal
 * @param options.onProgress  ({ stage, message, percent, detail }) => void
 * @param options.media  probe result, when the caller already has one
 * @param options.tools  { ffmpeg, ffprobe, whisper } commands (default: from PATH)
 * @param options.models  { whisper, vad } model paths; required for speech analysis
 * @param options.whisper  { prompt, threads }: vocabulary hint and CPU threads for whisper-cli
 * @param options.speech  { transcript, textEdits } replacing Whisper and take detection (see applyDecisions)
 * @param options.dependencies  replaces I/O steps in tests
 */
export async function analyze(inputPath, settingsInput, {
  signal,
  onProgress = () => {},
  media: knownMedia = null,
  tools = {},
  models = {},
  whisper = {},
  speech = null,
  createId = randomUUID,
  dependencies = {},
} = {}) {
  const settings = normalizeAnalysisSettings(settingsInput);
  const io = { probeMedia, detectSilences, transcribeMedia, detectTextEdits, detectLastTakeEdits, ...dependencies };
  const ffmpegCommand = tools.ffmpeg ?? "ffmpeg";
  const progress = (stage, message, percent = null, detail = null) => onProgress({ stage, message, percent, detail });
  if (speech && !settings.transcribe) throw new Error("Reviewed speech decisions need transcription enabled.");
  signal?.throwIfAborted();

  const media = knownMedia ?? await io.probeMedia(inputPath, { signal, ffprobeCommand: tools.ffprobe ?? "ffprobe" });
  const silencesFor = (silenceSettings) => io.detectSilences(inputPath, silenceSettings, { signal, ffmpegCommand });
  progress("silence", "Reading audio waveform…");
  const silences = await silencesFor(settings);

  let transcription = null;
  let textEdits = EMPTY_EDITS;
  let nonVerbal = EMPTY_EDITS;
  let measuredSilences = [];
  if (settings.transcribe || settings.removeNonVerbal) {
    progress("silence", "Finding quick retry pauses…");
    const transcriptSettings = transcriptionSilenceSettings(settings);
    const transcriptSilences = transcriptSettings.minimumSilence === settings.minimumSilence ? silences : await silencesFor(transcriptSettings);
    measuredSilences = transcriptSilences;

    if (speech) {
      progress("transcribe", "Reusing the reviewed transcript…", 100);
      transcription = speech.transcript;
    } else {
      progress("transcribe", "Transcribing speech locally with Whisper…", 0);
      transcription = await io.transcribeMedia(inputPath, {
        signal,
        regions: buildSpeechRegions(transcriptSilences, media.duration, { minimumSpeechSeconds: settings.removeNonVerbal ? 0.02 : 0.3 }),
        ffmpegCommand,
        whisperCommand: tools.whisper ?? "whisper-cli",
        modelPath: models.whisper,
        vadModelPath: models.vad,
        language: settings.language,
        prompt: whisper.prompt ?? "",
        threads: whisper.threads ?? null,
        onProgress: ({ completed, total }) => {
          const percent = total ? Math.min(99, Math.round(completed / total * 100)) : null;
          progress("transcribe", `Transcribing speech locally with Whisper · ${percent ?? 0}%`, percent, { completed, total });
        },
      });
    }

    if (speech) textEdits = speech.textEdits;
    else if (settings.transcribe) {
      progress("takes", "Finding repeated takes…");
      const detect = settings.duplicateMode === LAST_TAKE_DUPLICATE_MODE ? io.detectLastTakeEdits : io.detectTextEdits;
      textEdits = detect(transcription.segments, { autoConfidence: settings.textConfidence });
    }

    if (settings.removeNonVerbal) {
      progress("sounds", "Finding isolated sounds without words…");
      const soundSettings = nonVerbalSilenceSettings(settings);
      const soundSilences = soundSettings.minimumSilence === transcriptSettings.minimumSilence ? transcriptSilences : await silencesFor(soundSettings);
      measuredSilences = soundSilences;
      nonVerbal = detectNonVerbalSounds(buildSoundIslands(soundSilences, media.duration), {
        tokens: transcription.tokens,
        utterances: transcription.utterances,
        removedSpeech: settings.applyTextEdits ? textEdits.applied : [],
      });
    }
  }
  signal?.throwIfAborted();

  const silenceSegments = buildSegments(silences, media.duration, media.frameRate, settings.keepPause);
  const soundSegments = buildSegments([...silences, ...nonVerbal.applied.map(({ start, end }) => ({ start, end }))], media.duration, media.frameRate, settings.keepPause);
  const appliedTextEdits = settings.applyTextEdits ? textEdits.applied : [];
  const textPlan = addTextCuts(soundSegments, appliedTextEdits, media.frameRate, {
    maximumGapFrames: Math.ceil(secondsToFrames(settings.keepPause, media.frameRate) / 2),
  });

  // Only a requested transcript is kept for review; a non-verbal-only run
  // uses Whisper to find words, not to edit speech.
  const transcript = settings.transcribe && transcription
    ? { language: transcription.language, segments: transcription.segments, text: transcription.text }
    : null;
  const applied = new Set(appliedTextEdits);
  const textCandidates = [
    ...nonVerbal.candidates,
    ...textEdits.candidates.map((item) => ({ ...item, applied: applied.has(item) })),
  ].map((item) => ({ ...item, id: createId() }));
  const textEditSummary = textEdits.summary ?? null;
  const automatic = buildReviewedPlan(textPlan.removals, [], textPlan.durationFrames, {
    transcript,
    textCandidates,
    measuredSilences,
    reviewPolicy: textEditSummary?.reviewPolicy,
    minimumSilence: settings.minimumSilence,
    frameRate: media.frameRate,
    keepPause: settings.keepPause,
  });

  return {
    inputPath,
    media,
    settings,
    silences,
    silenceRemovals: silenceSegments.removals,
    automaticRemovals: automatic.removals,
    transcript,
    textCandidates,
    textEditSummary,
    // Detector output with object identity intact, for review packets and reports.
    transcription,
    textEdits,
    appliedTextEdits,
    nonVerbal,
  };
}

/**
 * Write a timeline document for an editor, or render the cut video (format "mp4").
 * @returns { path, format, label, rendered, keptRanges, removedRanges, durationSeconds?, importNote }
 */
export async function exportPlan(plan, {
  format = "final-cut",
  inputPath,
  outputPath,
  media,
  projectResolution,
  signal,
  onProgress = () => {},
  tools = {},
  dependencies = {},
}) {
  const io = { writeFile: writeFileToDisk, renderVideo, ...dependencies };
  const target = timelineExportFor(format);
  if (!plan.keeps.length) throw new Error("The edit plan removes the entire recording.");
  signal?.throwIfAborted();
  const summary = { path: outputPath, format, label: target.shortLabel, keptRanges: plan.keeps.length, removedRanges: plan.removals.length };
  if (target.renders) {
    const result = await io.renderVideo(inputPath, outputPath, {
      keeps: keepsToSeconds(plan.keeps, media.frameRate), media, projectResolution, signal, ffmpegCommand: tools.ffmpeg, onProgress,
    });
    return { ...summary, rendered: true, durationSeconds: result?.durationSeconds ?? null, importNote: null };
  }
  const parsed = path.parse(inputPath);
  const document = createTimelineDocument(format, {
    inputPath,
    clipName: parsed.base,
    compoundName: `${parsed.name} — Source`,
    projectName: `${parsed.name} — Rough Cut`,
    media,
    projectResolution,
    keeps: plan.keeps,
  });
  await io.writeFile(outputPath, document, "utf8");
  const importNote = format === "resolve" ? `Set the timeline to ${projectResolution.width}×${projectResolution.height} in Resolve after import` : null;
  return { ...summary, rendered: false, importNote };
}

function seconds(frames, frameRate) {
  return frames * frameRate.denominator / frameRate.numerator;
}

/** The JSON cut report: settings, cuts, transcript and every text/sound candidate. */
export function createReport(analysis, plan, { exportFormat, projectResolution, models = {} }) {
  const { media, settings, transcription, textEdits, appliedTextEdits, nonVerbal } = analysis;
  const speechAnalysisEnabled = settings.transcribe || settings.removeNonVerbal;
  const removedFrames = plan.removals.reduce((total, item) => total + item.endFrame - item.startFrame, 0);
  return {
    input: analysis.inputPath,
    settings: {
      thresholdDb: settings.thresholdDb,
      minimumSilenceSeconds: settings.minimumSilence,
      keepPauseSeconds: settings.keepPause,
      projectResolution: { choice: projectResolution.choice, width: projectResolution.width, height: projectResolution.height },
      exportFormat,
      transcription: speechAnalysisEnabled ? {
        language: settings.language,
        model: models.whisper ? path.resolve(models.whisper) : null,
        vadModel: models.vad ? path.resolve(models.vad) : null,
        duplicateMode: settings.transcribe ? settings.duplicateMode : null,
        confidenceThreshold: usesTextConfidence(settings.duplicateMode) ? settings.textConfidence : null,
        applyEdits: settings.applyTextEdits,
        removeNonVerbal: settings.removeNonVerbal,
      } : null,
    },
    originalDurationSeconds: media.duration,
    roughcutDurationSeconds: seconds(plan.durationFrames - removedFrames, media.frameRate),
    removedDurationSeconds: seconds(removedFrames, media.frameRate),
    cuts: plan.removals.map((item) => ({
      startSeconds: seconds(item.startFrame, media.frameRate),
      endSeconds: seconds(item.endFrame, media.frameRate),
      durationSeconds: seconds(item.endFrame - item.startFrame, media.frameRate),
    })),
    transcript: transcription ? {
      language: transcription.language,
      text: transcription.text,
      segments: settings.transcribe ? transcription.segments : [],
    } : null,
    textEdits: speechAnalysisEnabled ? {
      mode: settings.transcribe ? settings.duplicateMode : null,
      summary: textEdits.summary ?? null,
      applied: appliedTextEdits,
      autoEligible: textEdits.applied,
      requiresReview: textEdits.candidates.filter((item) => !textEdits.applied.includes(item)),
      suggestions: textEdits.candidates.filter((item) => !appliedTextEdits.includes(item)),
      nonVerbal: nonVerbal.candidates,
    } : null,
  };
}
