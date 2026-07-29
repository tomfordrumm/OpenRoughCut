import { run } from "./process.js";

function parseRate(value) {
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error(`Unsupported video frame rate: ${value}`);
  }
  return { numerator, denominator };
}

export function parseMediaTimecode(value, frameRate) {
  const match = typeof value === "string" ? value.trim().match(/^(\d{2}):([0-5]\d):([0-5]\d)([:;])(\d{2})$/) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const separator = match[4];
  const frames = Number(match[5]);
  const timebase = Math.round(frameRate.numerator / frameRate.denominator);
  if (frames >= timebase) return null;

  const totalMinutes = hours * 60 + minutes;
  const nominalFrames = ((hours * 3600 + minutes * 60 + seconds) * timebase) + frames;
  if (separator === ";") {
    const isNtscRate = frameRate.denominator === 1001 && frameRate.numerator === timebase * 1000;
    if (!isNtscRate || ![30, 60].includes(timebase)) return null;
    const droppedPerMinute = timebase === 60 ? 4 : 2;
    const droppedFrames = droppedPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
    return { string: value.trim(), frame: nominalFrames - droppedFrames, displayFormat: "DF" };
  }
  return { string: value.trim(), frame: nominalFrames, displayFormat: "NDF" };
}

function timecodeTag(tags) {
  if (!tags || typeof tags !== "object") return null;
  const entry = Object.entries(tags).find(([key, value]) => key.toLowerCase() === "timecode" && typeof value === "string");
  return entry?.[1] ?? null;
}

function rotationTag(tags) {
  if (!tags || typeof tags !== "object") return null;
  const entry = Object.entries(tags).find(([key]) => key.toLowerCase() === "rotate");
  const rotation = Number(entry?.[1]);
  return Number.isFinite(rotation) ? rotation : null;
}

export function displayDimensions(video) {
  const width = Number(video?.width);
  const height = Number(video?.height);
  const sideDataRotation = video?.side_data_list
    ?.map((item) => Number(item?.rotation))
    .find(Number.isFinite);
  const rotation = sideDataRotation ?? rotationTag(video?.tags) ?? 0;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  return normalizedRotation === 90 || normalizedRotation === 270
    ? { width: height, height: width }
    : { width, height };
}

export async function probeMedia(inputPath, { signal, ffprobeCommand = "ffprobe" } = {}) {
  const { stdout } = await run(ffprobeCommand, [
    "-v", "error",
    "-show_entries", "format=duration,format_name:format_tags=timecode:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,channel_layout:stream_tags=timecode,rotate:stream_side_data=rotation",
    "-of", "json",
    inputPath,
  ], { signal });

  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration);

  if (!video) throw new Error("The input file has no video stream.");
  if (!audio) throw new Error("The input file has no audio stream to analyse.");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine the media duration.");

  const rateValue = video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate;
  const frameRate = parseRate(rateValue);
  const streamTimecode = data.streams?.map((stream) => timecodeTag(stream.tags)).find(Boolean);
  const parsedTimecode = parseMediaTimecode(timecodeTag(video.tags), frameRate)
    ?? parseMediaTimecode(streamTimecode, frameRate)
    ?? parseMediaTimecode(timecodeTag(data.format?.tags), frameRate);
  const audioChannels = Number(audio.channels) || 2;
  const dimensions = displayDimensions(video);

  return {
    duration,
    width: dimensions.width,
    height: dimensions.height,
    frameRate,
    audioChannels,
    audioRate: Number(audio.sample_rate) || 48000,
    audioLayout: typeof audio.channel_layout === "string" && audio.channel_layout ? audio.channel_layout : audioChannels === 2 ? "stereo" : audioChannels === 1 ? "mono" : "unknown",
    videoCodec: typeof video.codec_name === "string" ? video.codec_name : "unknown",
    audioCodec: typeof audio.codec_name === "string" ? audio.codec_name : "unknown",
    formatNames: typeof data.format?.format_name === "string" ? data.format.format_name.split(",") : [],
    sourceTimecode: parsedTimecode?.string ?? "00:00:00:00",
    sourceStartFrame: parsedTimecode?.frame ?? 0,
    sourceTimecodeDisplayFormat: parsedTimecode?.displayFormat ?? "NDF",
  };
}

export async function detectSilences(inputPath, { thresholdDb, minimumSilence }, { signal, ffmpegCommand = "ffmpeg" } = {}) {
  const silences = [];
  let openStart = null;

  const parseLine = (line) => {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) openStart = Number(start[1]);

    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && openStart !== null) {
      silences.push({ start: openStart, end: Number(end[1]) });
      openStart = null;
    }
  };

  await run(ffmpegCommand, [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-map", "0:a:0",
    "-af", `silencedetect=noise=${thresholdDb}dB:d=${minimumSilence}`,
    "-f", "null", "-",
  ], { onStderrLine: parseLine, signal });

  return silences;
}
