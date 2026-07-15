import { run } from "./process.js";

function parseRate(value) {
  const [numerator, denominator = "1"] = String(value).split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error(`Unsupported video frame rate: ${value}`);
  }
  return { numerator, denominator };
}

export async function probeMedia(inputPath) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels",
    "-of", "json",
    inputPath,
  ]);

  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration);

  if (!video) throw new Error("The input file has no video stream.");
  if (!audio) throw new Error("The input file has no audio stream to analyse.");
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine the media duration.");

  const rateValue = video.avg_frame_rate !== "0/0" ? video.avg_frame_rate : video.r_frame_rate;
  const frameRate = parseRate(rateValue);

  return {
    duration,
    width: Number(video.width),
    height: Number(video.height),
    frameRate,
    audioChannels: Number(audio.channels) || 2,
    audioRate: Number(audio.sample_rate) || 48000,
  };
}

export async function detectSilences(inputPath, { thresholdDb, minimumSilence }) {
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

  await run("ffmpeg", [
    "-hide_banner", "-nostats", "-i", inputPath,
    "-map", "0:a:0",
    "-af", `silencedetect=noise=${thresholdDb}dB:d=${minimumSilence}`,
    "-f", "null", "-",
  ], { onStderrLine: parseLine });

  return silences;
}
