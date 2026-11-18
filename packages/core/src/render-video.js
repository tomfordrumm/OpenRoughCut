// Render the edit plan straight to a video file: every kept range is trimmed
// from the source and the pieces are joined in order. Audio gets a 5 ms fade at
// each join so cuts do not click. The output is scaled and letterboxed to the
// timeline size, like an editor would place the source in that timeline.
import { mkdtemp, rm, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run } from "./process.js";

export const JOIN_FADE_SECONDS = 0.005;

const num = (value) => Number(value.toFixed(6)).toString();

/** Seconds from frame-based keeps: [{ startFrame, endFrame }]. */
export function keepsToSeconds(keeps, frameRate) {
  const frameSeconds = frameRate.denominator / frameRate.numerator;
  return keeps.map((keep) => ({ start: keep.startFrame * frameSeconds, end: keep.endFrame * frameSeconds })).filter((keep) => keep.end > keep.start);
}

/** The FFmpeg filter graph for kept ranges in seconds. */
export function renderFilterGraph(keeps, { hasAudio = true, width, height, sourceWidth, sourceHeight, fade = JOIN_FADE_SECONDS } = {}) {
  if (!keeps.length) throw new Error("The edit plan removes the entire recording.");
  const parts = [];
  const inputs = [];
  keeps.forEach((keep, i) => {
    const length = keep.end - keep.start;
    parts.push(`[0:v:0]trim=start=${num(keep.start)}:end=${num(keep.end)},setpts=PTS-STARTPTS[v${i}]`);
    inputs.push(`[v${i}]`);
    if (hasAudio) {
      const fadeLength = Math.min(fade, length / 4);
      parts.push(`[0:a:0]atrim=start=${num(keep.start)}:end=${num(keep.end)},asetpts=PTS-STARTPTS,afade=t=in:d=${num(fadeLength)},afade=t=out:st=${num(Math.max(0, length - fadeLength))}:d=${num(fadeLength)}[a${i}]`);
      inputs.push(`[a${i}]`);
    }
  });
  parts.push(`${inputs.join("")}concat=n=${keeps.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? "[aout]" : ""}`);
  const resize = width && height && (width !== sourceWidth || height !== sourceHeight)
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,`
    : "";
  parts.push(`[vc]${resize}setsar=1,format=yuv420p[vout]`);
  return parts.join(";\n");
}

/** A visually transparent H.264 bitrate for the frame size and rate. */
export function videoBitrate(width, height, fps) {
  return Math.round(Math.min(80, Math.max(4, (width * height * Math.min(fps, 60) * 0.15) / 1e6)));
}

export function renderArguments({ inputPath, outputPath, graphPath, hasAudio, frameRate, width, height, encoder, scriptOption = "-/filter_complex" }) {
  const fps = frameRate.numerator / frameRate.denominator;
  const video = encoder === "videotoolbox"
    ? ["-c:v", "h264_videotoolbox", "-b:v", `${videoBitrate(width, height, fps)}M`, "-profile:v", "high"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "18"];
  return [
    "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:2",
    "-i", inputPath,
    scriptOption, graphPath,
    "-map", "[vout]", ...(hasAudio ? ["-map", "[aout]"] : []),
    ...video,
    "-fps_mode", "cfr", "-r", `${frameRate.numerator}/${frameRate.denominator}`,
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
    "-movflags", "+faststart",
    outputPath,
  ];
}

/**
 * Render `keeps` (seconds) of `inputPath` to `outputPath`. Writes to a
 * temporary file first, so a failed or cancelled render never leaves a
 * half-written video under the chosen name.
 */
export async function renderVideo(inputPath, outputPath, {
  keeps, media, projectResolution, ffmpegCommand = "ffmpeg", signal, onProgress,
  runCommand = run, platform = process.platform,
} = {}) {
  const width = projectResolution?.width ?? media.width;
  const height = projectResolution?.height ?? media.height;
  const hasAudio = media.audioChannels !== 0;
  const total = keeps.reduce((sum, keep) => sum + keep.end - keep.start, 0);
  const graph = renderFilterGraph(keeps, { hasAudio, width, height, sourceWidth: media.width, sourceHeight: media.height });
  const directory = await mkdtemp(path.join(tmpdir(), "roughcut-render-"));
  const graphPath = path.join(directory, "graph.txt");
  const partialPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.partial.mp4`);
  await writeFile(graphPath, graph, "utf8");
  const onStderrLine = (line) => {
    const match = line.match(/^out_time_(?:us|ms)=(\d+)$/);
    if (match && total > 0) onProgress?.({ percent: Math.max(0, Math.min(99, Math.round(Number(match[1]) / 1e6 / total * 100))) });
  };
  const attempt = async (encoder, scriptOption) => {
    await runCommand(ffmpegCommand, renderArguments({ inputPath, outputPath: partialPath, graphPath, hasAudio, frameRate: media.frameRate, width, height, encoder, scriptOption }), { signal, onStderrLine });
    if ((await stat(partialPath)).size < 1_000) throw new Error("FFmpeg did not produce a valid video.");
  };
  try {
    onProgress?.({ percent: 0 });
    const encoders = platform === "darwin" ? ["videotoolbox", "x264"] : ["x264"];
    let lastError = null;
    for (const encoder of encoders) {
      try {
        try { await attempt(encoder, "-/filter_complex"); }
        catch (error) {
          // FFmpeg before 7.0 only knows the older spelling.
          if (signal?.aborted || !/Unrecognized option|Option not found/i.test(error.message)) throw error;
          await attempt(encoder, "-filter_complex_script");
        }
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await unlink(partialPath).catch(() => {});
        if (signal?.aborted) throw error;
      }
    }
    if (lastError) throw lastError;
    await rename(partialPath, outputPath);
    onProgress?.({ percent: 100 });
    return { outputPath, durationSeconds: total, pieces: keeps.length, width, height };
  } finally {
    await unlink(partialPath).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
