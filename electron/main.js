import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAppLogger } from "../src/app-logger.js";
import { applyManualOverrides } from "../src/edit-plan.js";
import { detectSilences, probeMedia } from "../src/media.js";
import { createMediaResponse } from "../src/media-stream.js";
import { buildSoundIslands, detectNonVerbalSounds, nonVerbalSilenceSettings } from "../src/nonverbal.js";
import { previewKeyframeOptions } from "../src/playback.js";
import { run } from "../src/process.js";
import { reconcileProxyMetadata } from "../src/proxy-metadata.js";
import { PROJECT_RESOLUTIONS as PROJECT_RESOLUTION_OPTIONS, resolveProjectResolution } from "../src/resolution.js";
import { addTextCuts, buildSegments, buildSpeechRegions, secondsToFrames, transcriptionSilenceSettings } from "../src/segments.js";
import { detectTextEdits } from "../src/text-edits.js";
import { transcribeMedia } from "../src/transcribe.js";
import { createTimelineDocument, timelineExportFor } from "../src/timeline-export.js";
import { analysisFingerprint, SESSION_VERSION } from "../src/session.js";
import { inspectRuntimeDependencies, installMissingDependencies } from "../src/runtime-dependencies.js";
import { DEFAULT_TRANSCRIPTION_MODEL_ID, isTranscriptionModelId } from "../src/transcription-models.js";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const mediaSources = new Map();
const mediaTokens = new Map();
const MAX_SESSION_BYTES = 50 * 1024 * 1024;
const PROJECT_RESOLUTIONS = new Set(Object.keys(PROJECT_RESOLUTION_OPTIONS));
const PROXY_ID = /^[a-f0-9]{24}$/;
const PARTIAL_PROXY = /\.partial\.mp4$/;
const PARTIAL_PROXY_MAX_AGE = 24 * 60 * 60 * 1_000;
const VIDEO_PROBE_TIMEOUT_MS = 60_000;
let activeOperation = null;
let runtimeStatus = null;
let selectedTranscriptionModelId = DEFAULT_TRANSCRIPTION_MODEL_ID;
let recoveryWrite = Promise.resolve();
let appLogger = {
  filePath: null,
  info: () => {},
  warn: () => {},
  error: () => {},
};
const flushApproved = new WeakSet();
const flushTimers = new WeakMap();

protocol.registerSchemesAsPrivileged([{ scheme: "roughcut-media", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

function sendProgress(sender, operation, phase, message, percent = null) {
  if (!sender.isDestroyed()) sender.send("operation:progress", { operation, phase, message, percent });
}

async function runOperation(event, operation, task) {
  if (activeOperation) throw new Error(`${activeOperation.operation} is already running. Cancel it before starting another task.`);
  const controller = new AbortController();
  activeOperation = { operation, controller, senderId: event.sender.id };
  try {
    return await task(controller.signal);
  } catch (error) {
    appLogger.error("operation.failed", error, { operation });
    if (error.name === "AbortError") sendProgress(event.sender, operation, "cancelled", "Operation cancelled");
    throw error;
  } finally {
    if (activeOperation?.controller === controller) activeOperation = null;
  }
}

function cancelOperation(event) {
  if (!activeOperation || activeOperation.senderId !== event.sender.id) return { cancelled: false };
  const operation = activeOperation.operation;
  activeOperation.controller.abort();
  return { cancelled: true, operation };
}

function autosavePath() {
  return path.join(app.getPath("userData"), "recovery-session.json");
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_BYTES) throw new Error("This session is too large to save safely.");
  await writeFile(temporaryPath, serialized, "utf8");
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    const backupPath = `${filePath}.${randomUUID()}.bak`;
    let backedUp = false;
    try {
      await rename(filePath, backupPath);
      backedUp = true;
    } catch (backupError) {
      if (backupError.code !== "ENOENT") {
        await unlink(temporaryPath).catch(() => {});
        throw backupError;
      }
    }
    try {
      await rename(temporaryPath, filePath);
      if (backedUp) await unlink(backupPath).catch(() => {});
    } catch (replaceError) {
      if (backedUp) await rename(backupPath, filePath).catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw replaceError;
    }
  }
}

function writeRecovery(document) {
  recoveryWrite = recoveryWrite.catch(() => {}).then(() => writeJsonAtomic(autosavePath(), document));
  return recoveryWrite;
}

function clearRecovery() {
  recoveryWrite = recoveryWrite.catch(() => {}).then(async () => {
    try {
      await unlink(autosavePath());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
  return recoveryWrite;
}

function assertTranscriptionModelId(value) {
  if (!isTranscriptionModelId(value)) throw new Error("Unknown transcription model.");
  return value;
}

async function refreshRuntimeStatus(modelId = selectedTranscriptionModelId) {
  try {
    selectedTranscriptionModelId = assertTranscriptionModelId(modelId);
    runtimeStatus = await inspectRuntimeDependencies({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath("userData"),
      developmentRoot: app.isPackaged ? null : path.resolve(import.meta.dirname, ".."),
      selectedModelId: selectedTranscriptionModelId,
    });
    appLogger.info("runtime.checked", {
      platform: runtimeStatus.platform,
      arch: runtimeStatus.arch,
      coreReady: runtimeStatus.coreReady,
      transcriptionReady: runtimeStatus.transcriptionReady,
      ffmpegSource: runtimeStatus.ffmpeg.source,
      ffprobeSource: runtimeStatus.ffprobe.source,
      ffprobeCommand: runtimeStatus.ffprobe.command,
      whisperSource: runtimeStatus.whisper.source,
    });
    return runtimeStatus;
  } catch (error) {
    appLogger.error("runtime.check.failed", error);
    throw error;
  }
}

async function currentRuntimeStatus() {
  return runtimeStatus ?? refreshRuntimeStatus();
}

async function probeSelectedVideo(sourcePath, ffprobeCommand) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VIDEO_PROBE_TIMEOUT_MS);
  try {
    return await probeMedia(sourcePath, { signal: controller.signal, ffprobeCommand });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw new Error("Video inspection took more than one minute. Copy the file to a local folder and try again.", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function resultForSource(sourcePath, media, { sessionPath = null } = {}) {
  const sourceId = randomUUID();
  const mediaToken = randomUUID();
  mediaSources.set(sourceId, { sourcePath, media, mediaToken, sessionPath });
  mediaTokens.set(mediaToken, sourcePath);
  return { sourceId, sourceUrl: `roughcut-media://source/${mediaToken}`, name: path.basename(sourcePath), media };
}

function registerMediaPath(filePath) {
  const token = randomUUID();
  mediaTokens.set(token, filePath);
  return `roughcut-media://source/${token}`;
}

function proxyCacheDirectory() {
  return path.join(app.getPath("cache"), "roughcut", "previews");
}

function proxyMetadata(source, signature) {
  const dimensions = proxyDimensions(source.media.width, source.media.height);
  return {
    version: 3,
    id: signature,
    sourceName: path.basename(source.sourcePath),
    width: dimensions.width,
    height: dimensions.height,
    duration: source.media.duration,
    createdAt: new Date().toISOString(),
  };
}

function proxyDimensions(width, height) {
  const scale = Math.min(1, 1280 / width, 720 / height);
  return {
    width: Math.max(2, Math.round(width * scale / 2) * 2),
    height: Math.max(2, Math.round(height * scale / 2) * 2),
  };
}

async function cleanupPartialProxies(cacheDirectory) {
  const entries = await readdir(cacheDirectory, { withFileTypes: true });
  const cutoff = Date.now() - PARTIAL_PROXY_MAX_AGE;
  await Promise.all(entries
    .filter((entry) => entry.isFile() && PARTIAL_PROXY.test(entry.name))
    .map(async (entry) => {
      const filePath = path.join(cacheDirectory, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (info && info.mtimeMs < cutoff) await unlink(filePath).catch(() => {});
    }));
}

async function writeProxyMetadata(cacheDirectory, source, signature) {
  const metadataPath = path.join(cacheDirectory, `${signature}.json`);
  let existing = null;
  try {
    existing = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const { metadata, needsWrite } = reconcileProxyMetadata(existing, proxyMetadata(source, signature));
  if (needsWrite) await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function listProxyCache(activeSourceId) {
  const cacheDirectory = proxyCacheDirectory();
  await mkdir(cacheDirectory, { recursive: true });
  await cleanupPartialProxies(cacheDirectory);
  const activeSignature = mediaSources.get(activeSourceId)?.previewSignature ?? null;
  const entries = await readdir(cacheDirectory, { withFileTypes: true });
  const proxies = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mp4") && PROXY_ID.test(path.basename(entry.name, ".mp4")))
    .map(async (entry) => {
      const id = path.basename(entry.name, ".mp4");
      const filePath = path.join(cacheDirectory, entry.name);
      const fileInfo = await stat(filePath);
      let metadata = null;
      try {
        const parsed = JSON.parse(await readFile(path.join(cacheDirectory, `${id}.json`), "utf8"));
        if ([1, 2, 3].includes(parsed?.version) && parsed.id === id) metadata = parsed;
      } catch {}
      return {
        id,
        sourceName: sanitizeText(metadata?.sourceName, 500) || "Unknown source (older proxy)",
        width: Number(metadata?.width) || null,
        height: Number(metadata?.height) || null,
        duration: Number(metadata?.duration) || null,
        size: fileInfo.size,
        modifiedAt: fileInfo.mtime.toISOString(),
        current: id === activeSignature,
      };
    }));
  proxies.sort((first, second) => Number(second.current) - Number(first.current) || second.modifiedAt.localeCompare(first.modifiedAt));
  return { cacheLocation: cacheDirectory, totalSize: proxies.reduce((sum, item) => sum + item.size, 0), proxies };
}

async function deleteProxyCacheEntries(ids) {
  if (!Array.isArray(ids) || ids.length > 10_000 || ids.some((id) => typeof id !== "string" || !PROXY_ID.test(id))) throw new Error("Invalid proxy selection.");
  const cacheDirectory = proxyCacheDirectory();
  const deletedIds = [];
  for (const id of new Set(ids)) {
    const proxyPath = path.join(cacheDirectory, `${id}.mp4`);
    try {
      await unlink(proxyPath);
      deletedIds.push(id);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await unlink(path.join(cacheDirectory, `${id}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    for (const [token, filePath] of mediaTokens) if (filePath === proxyPath) mediaTokens.delete(token);
    for (const source of mediaSources.values()) if (source.previewSignature === id) source.previewSignature = null;
  }
  return { deletedIds };
}

function sourceForId(sourceId) {
  if (typeof sourceId !== "string") throw new Error("Choose a source recording first.");
  const source = mediaSources.get(sourceId);
  if (!source) throw new Error("The source recording is no longer available. Choose or reopen it.");
  return source;
}

function assertProjectResolution(value) {
  const resolution = value ?? "source";
  if (!PROJECT_RESOLUTIONS.has(resolution)) throw new Error("Unsupported project resolution.");
  return resolution;
}

function assertExportFormat(value) {
  const format = value ?? "final-cut";
  timelineExportFor(format);
  return format;
}

function assertRanges(value, { actions = false } = {}) {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("The edit range list is invalid.");
  return value.map((range) => {
    if (!range || typeof range !== "object") throw new Error("An edit range is invalid.");
    const start = Number(actions ? range.start : range.startFrame);
    const end = Number(actions ? range.end : range.endFrame);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("An edit range has invalid timing.");
    if (actions) {
      if (!['keep', 'remove'].includes(range.action)) throw new Error("An edit range has an invalid action.");
      return {
        id: typeof range.id === "string" ? range.id.slice(0, 100) : randomUUID(),
        action: range.action,
        start,
        end,
        originKey: typeof range.originKey === "string" ? range.originKey.slice(0, 100) : null,
      };
    }
    return { startFrame: start, endFrame: end };
  });
}

function clampRange(start, end, maximum) {
  const a = Math.max(0, Math.min(maximum, start));
  const b = Math.max(0, Math.min(maximum, end));
  return a <= b ? [a, b] : [b, a];
}

function sanitizedFrameRanges(value, durationFrames) {
  return assertRanges(value).map((range) => {
    const [startFrame, endFrame] = clampRange(Math.round(range.startFrame), Math.round(range.endFrame), durationFrames);
    return { startFrame, endFrame };
  }).filter((range) => range.endFrame > range.startFrame);
}

function sanitizedManualOverrides(value, duration) {
  const ids = new Set();
  return assertRanges(value, { actions: true }).map((range) => {
    const [start, end] = clampRange(range.start, range.end, duration);
    let id = range.id;
    if (ids.has(id)) id = randomUUID();
    ids.add(id);
    return { ...range, id, start, end };
  }).filter((range) => range.end > range.start);
}

function assertSettings(settings) {
  const thresholdDb = Number(settings?.thresholdDb);
  const minimumSilence = Number(settings?.minimumSilence);
  const keepPause = Number(settings?.keepPause);
  if (!Number.isFinite(thresholdDb) || thresholdDb > 0 || thresholdDb < -100) throw new Error("Threshold must be between -100 and 0 dB.");
  if (!Number.isFinite(minimumSilence) || minimumSilence <= 0) throw new Error("Minimum silence must be greater than zero.");
  if (!Number.isFinite(keepPause) || keepPause < 0 || keepPause >= minimumSilence) throw new Error("Pause to keep must be non-negative and shorter than minimum silence.");
  return { thresholdDb, minimumSilence, keepPause };
}

function assertAnalysisOptions(request) {
  const includeTranscript = request?.includeTranscript === true;
  const removeNonVerbal = request?.removeNonVerbal === true;
  const textConfidence = Number(request?.textConfidence ?? 0.9);
  if (!Number.isFinite(textConfidence) || textConfidence < 0.5 || textConfidence > 0.99) throw new Error("Text confidence must be between 0.5 and 0.99.");
  const transcriptionModelId = assertTranscriptionModelId(request?.transcriptionModelId ?? DEFAULT_TRANSCRIPTION_MODEL_ID);
  return { includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId };
}

function sanitizeText(value, maximum = 2_000) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function sanitizedAnalysis(value, media) {
  const durationFrames = secondsToFrames(media.duration, media.frameRate);
  const automaticRemovals = sanitizedFrameRanges(value?.automaticRemovals ?? [], durationFrames);
  const silenceRemovals = sanitizedFrameRanges(value?.silenceRemovals ?? [], durationFrames);
  const textCandidates = Array.isArray(value?.textCandidates) ? value.textCandidates.slice(0, 5_000).map((item) => {
    const [start, end] = clampRange(Number(item?.start), Number(item?.end), media.duration);
    return {
      id: sanitizeText(item?.id, 100) || randomUUID(),
      reason: item?.reason === "false-start" ? "false-start" : item?.reason === "non-verbal" ? "non-verbal" : "repeated-take",
      start,
      end,
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      similarity: Math.max(0, Math.min(1, Number(item?.similarity) || 0)),
      removedText: sanitizeText(item?.removedText, 500),
      keptText: sanitizeText(item?.keptText, 500),
      applied: item?.applied === true,
    };
  }).filter((item) => item.end > item.start) : [];
  const transcriptSegments = Array.isArray(value?.transcript?.segments) ? value.transcript.segments.slice(0, 30_000).map((item) => {
    const [start, end] = clampRange(Number(item?.start), Number(item?.end), media.duration);
    return { start, end, text: sanitizeText(item?.text, 1_000) };
  }).filter((item) => item.end > item.start && item.text) : [];
  return {
    automaticRemovals,
    silenceRemovals,
    textCandidates,
    transcript: transcriptSegments.length ? { language: sanitizeText(value?.transcript?.language, 30) || "unknown", segments: transcriptSegments } : null,
  };
}

async function preparePreview(source, sender, { signal, ffmpegCommand = "ffmpeg" } = {}) {
  const info = await stat(source.sourcePath);
  const signature = createHash("sha256").update(`roughcut-preview-v3\0${source.sourcePath}\0${info.size}\0${info.mtimeMs}`).digest("hex").slice(0, 24);
  const cacheDirectory = proxyCacheDirectory();
  const outputPath = path.join(cacheDirectory, `${signature}.mp4`);
  const temporaryPath = path.join(cacheDirectory, `${signature}.${randomUUID()}.partial.mp4`);
  await mkdir(cacheDirectory, { recursive: true });
  await cleanupPartialProxies(cacheDirectory);
  try {
    const cached = await stat(outputPath);
    if (cached.size > 0) {
      source.previewSignature = signature;
      await writeProxyMetadata(cacheDirectory, source, signature);
      sendProgress(sender, "preview", "done", "Preview proxy ready", 100);
      return { previewUrl: registerMediaPath(outputPath), cached: true };
    }
  } catch {}

  const progressLine = (line) => {
    const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
    if (!match) return;
    const seconds = Number(match[1]) / 1_000_000;
    const percent = Math.max(0, Math.min(99, Math.round(seconds / source.media.duration * 100)));
    sendProgress(sender, "preview", "running", `Building playback proxy · ${percent}%`, percent);
  };
  const common = [
    "-y", "-hide_banner", "-loglevel", "error", "-i", source.sourcePath,
    "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2",
    ...previewKeyframeOptions(source.media.frameRate),
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-progress", "pipe:2", "-nostats",
  ];
  sendProgress(sender, "preview", "running", "Building Chromium playback proxy…", 0);
  try {
    try {
      if (process.platform !== "darwin") throw new Error("Hardware encoding is not available on this platform.");
      await run(ffmpegCommand, [...common, "-c:v", "h264_videotoolbox", "-b:v", "2500k", "-pix_fmt", "yuv420p", temporaryPath], { onStderrLine: progressLine, signal });
      if ((await stat(temporaryPath)).size < 1_000) throw new Error("The hardware encoder did not produce a valid proxy.");
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      if (signal?.aborted) throw error;
      await run(ffmpegCommand, [...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", temporaryPath], { onStderrLine: progressLine, signal });
      if ((await stat(temporaryPath)).size < 1_000) throw new Error("FFmpeg did not produce a valid proxy.");
    }
    await rename(temporaryPath, outputPath);
    source.previewSignature = signature;
    await writeProxyMetadata(cacheDirectory, source, signature);
    sendProgress(sender, "preview", "done", "Preview proxy ready", 100);
    return { previewUrl: registerMediaPath(outputPath), cached: false };
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    sendProgress(sender, "preview", "error", error.message);
    throw error;
  }
}

function manualFrames(overrides, frameRate) {
  return (overrides ?? []).map((item) => ({
    action: item.action,
    startFrame: secondsToFrames(item.start, frameRate),
    endFrame: secondsToFrames(item.end, frameRate),
  }));
}

function sessionDocument(session, source, sessionPath = null) {
  const settings = assertSettings(session.settings);
  const projectResolution = assertProjectResolution(session.projectResolution);
  const exportFormat = assertExportFormat(session.exportFormat);
  const includeTranscript = session.includeTranscript === true;
  const removeNonVerbal = session.removeNonVerbal === true;
  const { textConfidence, transcriptionModelId } = assertAnalysisOptions(session);
  const analysis = sanitizedAnalysis(session.analysis, source.media);
  const manualOverrides = sanitizedManualOverrides(session.manualOverrides ?? [], source.media.duration);
  const computedSignature = analysisFingerprint({ settings, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId });
  const analysisSignature = typeof session.analysisSignature === "string" && session.analysisSignature === computedSignature
    ? session.analysisSignature
    : null;
  return {
    version: SESSION_VERSION,
    sourcePath: source.sourcePath,
    sessionPath,
    savedAt: new Date().toISOString(),
    settings,
    projectResolution,
    exportFormat,
    includeTranscript,
    removeNonVerbal,
    textConfidence,
    transcriptionModelId,
    analysisSignature,
    analysis,
    manualOverrides,
  };
}

async function loadSessionFile(filePath, { recovery = false } = {}) {
  const fileInfo = await stat(filePath);
  if (fileInfo.size > MAX_SESSION_BYTES) throw new Error("This session file is too large.");
  const session = JSON.parse(await readFile(filePath, "utf8"));
  if (![1, SESSION_VERSION].includes(session.version) || !session.sourcePath || !session.settings) {
    throw new Error("This is not a supported OpenRoughCut session.");
  }
  await stat(session.sourcePath);
  const runtime = await currentRuntimeStatus();
  if (!runtime.ffprobe.ready) throw new Error("FFprobe is required before a session can be opened.");
  const media = await probeMedia(session.sourcePath, { ffprobeCommand: runtime.ffprobe.command });
  const settings = assertSettings(session.settings);
  const projectResolution = assertProjectResolution(session.projectResolution);
  const exportFormat = assertExportFormat(session.exportFormat);
  const analysis = sanitizedAnalysis(session.analysis, media);
  const manualOverrides = sanitizedManualOverrides(session.manualOverrides ?? [], media.duration);
  const includeTranscript = session.version === 1 ? Boolean(analysis.transcript) : session.includeTranscript === true;
  const removeNonVerbal = session.removeNonVerbal === true;
  const { textConfidence, transcriptionModelId } = assertAnalysisOptions({
    textConfidence: session.textConfidence ?? 0.9,
    transcriptionModelId: session.transcriptionModelId ?? DEFAULT_TRANSCRIPTION_MODEL_ID,
  });
  const analysisSignature = session.version === 1
    ? null
    : typeof session.analysisSignature === "string" ? session.analysisSignature : null;
  const storedSessionPath = recovery ? sanitizeText(session.sessionPath, 5_000) || null : filePath;
  return {
    version: SESSION_VERSION,
    settings,
    projectResolution,
    exportFormat,
    includeTranscript,
    removeNonVerbal,
    textConfidence,
    transcriptionModelId,
    analysisSignature,
    analysis,
    manualOverrides,
    ...resultForSource(session.sourcePath, media, { sessionPath: storedSessionPath }),
    sessionPath: storedSessionPath,
    recovered: recovery,
    savedAt: sanitizeText(session.savedAt, 100) || null,
  };
}

function registerIpc() {
  ipcMain.on("session:flush-complete", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || flushApproved.has(window)) return;
    flushApproved.add(window);
    clearTimeout(flushTimers.get(window));
    if (activeOperation?.senderId === event.sender.id) activeOperation.controller.abort();
    window.close();
  });

  ipcMain.handle("runtime:status", async (_event, request) => refreshRuntimeStatus(request?.transcriptionModelId ?? selectedTranscriptionModelId));

  ipcMain.handle("runtime:install", async (event, request) => runOperation(event, "setup", async (signal) => {
    const modelId = assertTranscriptionModelId(request?.transcriptionModelId ?? selectedTranscriptionModelId);
    const before = await refreshRuntimeStatus(modelId);
    sendProgress(event.sender, "setup", "running", "Preparing OpenRoughCut…", 0);
    await installMissingDependencies(before, {
      signal,
      onProgress: ({ stage, label, received, total }) => {
        const percent = total ? Math.max(0, Math.min(99, Math.round(received / total * 100))) : null;
        const message = stage === "install" ? `Installing ${label}…` : `Downloading ${label}${percent === null ? "" : ` · ${percent}%`}`;
        sendProgress(event.sender, "setup", "running", message, percent);
      },
    });
    const after = await refreshRuntimeStatus();
    if (!after.coreReady) throw new Error("The editing engine was installed but could not be started. Try setup again or reinstall OpenRoughCut.");
    const message = after.transcriptionReady ? "OpenRoughCut is ready" : "Video editing is ready";
    sendProgress(event.sender, "setup", "done", message, 100);
    return after;
  }));

  ipcMain.handle("operation:cancel", (event) => cancelOperation(event));

  ipcMain.handle("diagnostics:show-logs", async () => {
    if (!appLogger.filePath) throw new Error("The diagnostic log is not available yet.");
    appLogger.info("diagnostics.log.revealed");
    shell.showItemInFolder(appLogger.filePath);
    return { path: appLogger.filePath };
  });

  ipcMain.handle("video:choose", async () => {
    let sourcePath = null;
    try {
      const selected = await dialog.showOpenDialog({
        title: "Choose video for new project",
        properties: ["openFile"],
        filters: [{ name: "Video", extensions: ["mov", "mp4", "m4v", "mkv", "webm"] }],
      });
      if (selected.canceled || !selected.filePaths[0]) {
        appLogger.info("video.open.cancelled");
        return null;
      }
      sourcePath = selected.filePaths[0];
      appLogger.info("video.open.selected", { sourcePath });
      const runtime = await currentRuntimeStatus();
      if (!runtime.ffprobe.ready) throw new Error("FFprobe is not available. Complete setup before opening a video.");
      const media = await probeSelectedVideo(sourcePath, runtime.ffprobe.command);
      appLogger.info("video.open.succeeded", {
        sourcePath,
        duration: media.duration,
        width: media.width,
        height: media.height,
        videoCodec: media.videoCodec,
        audioCodec: media.audioCodec,
        frameRate: media.frameRate,
      });
      return resultForSource(sourcePath, media);
    } catch (error) {
      appLogger.error("video.open.failed", error, { sourcePath });
      throw error;
    }
  });

  ipcMain.handle("video:prepare-preview", async (event, request) => {
    const source = sourceForId(request?.sourceId);
    const runtime = await currentRuntimeStatus();
    if (!runtime.ffmpeg.ready) throw new Error("FFmpeg is not available. Complete setup before building a preview.");
    return runOperation(event, "preview", (signal) => preparePreview(source, event.sender, { signal, ffmpegCommand: runtime.ffmpeg.command }));
  });

  ipcMain.handle("storage:list-proxies", async (_event, request) => listProxyCache(request?.sourceId));

  ipcMain.handle("storage:delete-proxies", async (_event, request) => deleteProxyCacheEntries(request?.ids));

  ipcMain.handle("video:analyze", async (event, request) => runOperation(event, "analysis", async (signal) => {
    const settings = assertSettings(request.settings);
    const options = assertAnalysisOptions(request);
    const source = sourceForId(request.sourceId);
    const speechAnalysisEnabled = options.includeTranscript || options.removeNonVerbal;
    const runtime = speechAnalysisEnabled
      ? await refreshRuntimeStatus(options.transcriptionModelId)
      : await currentRuntimeStatus();
    if (!runtime.ffmpeg.ready) throw new Error("FFmpeg is not available. Complete setup before analysing audio.");
    if (speechAnalysisEnabled && !runtime.transcriptionReady) throw new Error("Speech analysis setup is incomplete. Install the missing components first.");
    await stat(source.sourcePath);
    sendProgress(event.sender, "analysis", "running", "Reading audio waveform…");
    try {
      const media = source.media;
      const silences = await detectSilences(source.sourcePath, settings, { signal, ffmpegCommand: runtime.ffmpeg.command });
      const silenceSegments = buildSegments(silences, media.duration, media.frameRate, settings.keepPause);
      let segments = silenceSegments;
      let transcript = null;
      let textCandidates = [];
      if (speechAnalysisEnabled) {
        sendProgress(event.sender, "analysis", "running", "Finding quick retry pauses…");
        const transcriptSettings = transcriptionSilenceSettings(settings);
        const transcriptSilences = transcriptSettings.minimumSilence === settings.minimumSilence
          ? silences
          : await detectSilences(source.sourcePath, transcriptSettings, { signal, ffmpegCommand: runtime.ffmpeg.command });
        sendProgress(event.sender, "analysis", "running", "Transcribing speech locally with Whisper…");
        const speechRegions = buildSpeechRegions(transcriptSilences, media.duration, {
          minimumSpeechSeconds: options.removeNonVerbal ? 0.02 : 0.3,
        });
        const transcription = await transcribeMedia(source.sourcePath, {
          regions: speechRegions,
          signal,
          ffmpegCommand: runtime.ffmpeg.command,
          whisperCommand: runtime.whisper.command,
          modelPath: runtime.model.path,
          vadModelPath: runtime.vadModel.path,
        });
        transcript = options.includeTranscript ? {
          language: transcription.language,
          segments: transcription.segments,
          text: transcription.text,
        } : null;

        let nonVerbal = { candidates: [], applied: [] };
        if (options.removeNonVerbal) {
          sendProgress(event.sender, "analysis", "running", "Finding isolated sounds without words…");
          const soundSettings = nonVerbalSilenceSettings(settings);
          const soundSilences = soundSettings.minimumSilence === transcriptSettings.minimumSilence
            ? transcriptSilences
            : await detectSilences(source.sourcePath, soundSettings, { signal, ffmpegCommand: runtime.ffmpeg.command });
          nonVerbal = detectNonVerbalSounds(buildSoundIslands(soundSilences, media.duration), {
            tokens: transcription.tokens,
            utterances: transcription.utterances,
          });
          segments = buildSegments([
            ...silences,
            ...nonVerbal.applied.map((item) => ({ start: item.start, end: item.end })),
          ], media.duration, media.frameRate, settings.keepPause);
        }

        let textEdits = { candidates: [], applied: [] };
        if (options.includeTranscript) {
          sendProgress(event.sender, "analysis", "running", "Finding false starts and repeated takes…");
          textEdits = detectTextEdits(transcription.segments, { autoConfidence: options.textConfidence });
          segments = addTextCuts(segments, textEdits.applied, media.frameRate);
        }
        const appliedText = new Set(textEdits.applied);
        textCandidates = [
          ...nonVerbal.candidates,
          ...textEdits.candidates.map((item) => ({ ...item, applied: appliedText.has(item) })),
        ].map((item) => ({ ...item, id: randomUUID() }));
      }
      sendProgress(event.sender, "analysis", "done", `Found ${segments.removals.length} applied cuts`, 100);
      return { media, silences, silenceRemovals: silenceSegments.removals, automaticRemovals: segments.removals, transcript, textCandidates };
    } catch (error) {
      sendProgress(event.sender, "analysis", "error", error.message);
      throw error;
    }
  }));

  ipcMain.handle("session:save", async (_event, session) => {
    const source = sourceForId(session.sourceId);
    let filePath = source.sessionPath;
    if (!filePath) {
      const defaultPath = path.join(path.dirname(source.sourcePath), `${path.parse(source.sourcePath).name}.roughcut`);
      const selected = await dialog.showSaveDialog({ title: "Save OpenRoughCut project", defaultPath, filters: [{ name: "OpenRoughCut Project", extensions: ["roughcut"] }] });
      if (selected.canceled || !selected.filePath) return null;
      filePath = selected.filePath;
    }
    const document = sessionDocument(session, source, filePath);
    await writeJsonAtomic(filePath, document);
    source.sessionPath = filePath;
    await writeRecovery(document);
    return { path: filePath, savedAt: document.savedAt };
  });

  ipcMain.handle("session:autosave", async (_event, session) => {
    const source = sourceForId(session.sourceId);
    const document = sessionDocument(session, source, source.sessionPath);
    await writeRecovery(document);
    return { path: autosavePath(), savedAt: document.savedAt };
  });

  ipcMain.handle("session:close", async (_event, request) => {
    const source = sourceForId(request?.sourceId);
    mediaSources.delete(request.sourceId);
    mediaTokens.delete(source.mediaToken);
    await clearRecovery();
    return { closed: true };
  });

  ipcMain.handle("session:recover", async () => {
    try {
      return await loadSessionFile(autosavePath(), { recovery: true });
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });

  ipcMain.handle("session:load", async () => {
    const selected = await dialog.showOpenDialog({ title: "Open OpenRoughCut project", properties: ["openFile"], filters: [{ name: "OpenRoughCut Project", extensions: ["roughcut", "json"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    return loadSessionFile(selected.filePaths[0]);
  });

  ipcMain.handle("project:export", async (event, request) => {
    const source = sourceForId(request.sourceId);
    const parsed = path.parse(source.sourcePath);
    const exportFormat = assertExportFormat(request.exportFormat);
    const target = timelineExportFor(exportFormat);
    const settings = assertSettings(request.settings);
    const options = assertAnalysisOptions(request);
    const expectedSignature = analysisFingerprint({ settings, ...options });
    if (request.analysisSignature !== expectedSignature) throw new Error("Analysis settings changed. Re-analyse the source before exporting.");
    if (!Array.isArray(request.automaticRemovals)) throw new Error("Analyse the source before exporting.");
    const selected = await dialog.showSaveDialog({
      title: `Export ${target.label} timeline`,
      defaultPath: path.join(parsed.dir, `${parsed.name}.roughcut.${target.extension}`),
      filters: [{ name: target.filterName, extensions: [target.extension] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    return runOperation(event, "export", async () => {
      sendProgress(event.sender, "export", "running", "Building source-time edit plan…");
      try {
      const media = source.media;
      const automaticRemovals = assertRanges(request.automaticRemovals);
      const durationFrames = secondsToFrames(media.duration, media.frameRate);
      const manualOverrides = assertRanges(request.manualOverrides ?? [], { actions: true });
      const plan = applyManualOverrides(automaticRemovals, manualFrames(manualOverrides, media.frameRate), durationFrames);
      if (!plan.keeps.length) throw new Error("The edit plan removes the entire recording.");
      const projectResolution = resolveProjectResolution(media, assertProjectResolution(request.projectResolution));
      const document = createTimelineDocument(exportFormat, {
        inputPath: source.sourcePath,
        clipName: parsed.base,
        compoundName: `${parsed.name} — Source`,
        projectName: `${parsed.name} — Rough Cut`,
        media,
        projectResolution,
        keeps: plan.keeps,
      });
      await writeFile(selected.filePath, document, "utf8");
      const importNote = exportFormat === "resolve" ? `Set the timeline to ${projectResolution.width}×${projectResolution.height} in Resolve after import` : null;
      sendProgress(event.sender, "export", "done", `Exported ${target.shortLabel} · ${plan.keeps.length} retained ranges${importNote ? ` · ${importNote}` : ""}`);
      return { path: selected.filePath, format: exportFormat, label: target.shortLabel, keptRanges: plan.keeps.length, removedRanges: plan.removals.length, importNote };
      } catch (error) {
        sendProgress(event.sender, "export", "error", error.message);
        throw error;
      }
    });
  });
}

async function createWindow() {
  const entryUrl = devServerUrl
    ? new URL(devServerUrl).href
    : pathToFileURL(path.join(import.meta.dirname, "../dist/index.html")).href;
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: "#0d0f0f",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("preload-error", (_event, preloadPath, error) => appLogger.error("renderer.preload.failed", error, { preloadPath }));
  window.webContents.on("render-process-gone", (_event, details) => appLogger.error("renderer.process.gone", new Error(details.reason), details));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== entryUrl) event.preventDefault();
  });
  window.on("close", (event) => {
    if (flushApproved.has(window) || window.webContents.isDestroyed()) return;
    event.preventDefault();
    window.webContents.send("session:flush-request");
    clearTimeout(flushTimers.get(window));
    flushTimers.set(window, setTimeout(() => {
      flushApproved.add(window);
      if (activeOperation?.senderId === window.webContents.id) activeOperation.controller.abort();
      window.close();
    }, 4_000));
  });
  await window.loadURL(entryUrl);
}

app.whenReady().then(async () => {
  appLogger = createAppLogger({ directory: path.join(app.getPath("userData"), "logs") });
  appLogger.info("app.started", { version: app.getVersion(), platform: process.platform, arch: process.arch, packaged: app.isPackaged });
  protocol.handle("roughcut-media", (request) => {
    const token = new URL(request.url).pathname.slice(1);
    const sourcePath = mediaTokens.get(token);
    if (!sourcePath) return new Response("Unknown media source", { status: 404 });
    return createMediaResponse(request, sourcePath);
  });
  await refreshRuntimeStatus();
  registerIpc();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => activeOperation?.controller.abort());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

process.on("uncaughtExceptionMonitor", (error, origin) => appLogger.error("process.uncaught-exception", error, { origin }));
process.on("unhandledRejection", (reason) => appLogger.error("process.unhandled-rejection", reason));
