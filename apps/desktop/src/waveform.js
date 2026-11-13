// Audio peaks for drawing a waveform. FFmpeg decodes the first audio stream to
// low-rate mono PCM; we keep the loudest sample per bucket, scaled to 0–255 on
// a logarithmic (dB) curve so quiet speech is still visible.
import { spawn } from "node:child_process";
import { abortError } from "#core/process.js";

export const WAVEFORM_SAMPLE_RATE = 8000;
export const MAX_WAVEFORM_PEAKS = 400_000;
const FLOOR_DB = -60;

/** Peaks per second that keep a recording under MAX_WAVEFORM_PEAKS. */
export function waveformResolution(durationSeconds) {
  const duration = Math.max(1, Number(durationSeconds) || 1);
  for (const rate of [100, 50, 25, 20, 10, 5, 2, 1]) if (duration * rate <= MAX_WAVEFORM_PEAKS) return rate;
  return 1;
}

/** Map a 16-bit amplitude to 0–255 on a dB scale. */
export function peakLevel(amplitude) {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude / 32768);
  return Math.max(0, Math.min(255, Math.round((db - FLOOR_DB) / -FLOOR_DB * 255)));
}

/** Reduce little-endian s16 mono PCM chunks to per-bucket peak levels. */
export function createPeakAccumulator(samplesPerPeak) {
  const peaks = [];
  let carry = null;
  let current = 0;
  let count = 0;
  const push = (sample) => {
    const amplitude = Math.abs(sample);
    if (amplitude > current) current = amplitude;
    if (++count === samplesPerPeak) { peaks.push(peakLevel(current)); current = 0; count = 0; }
  };
  return {
    write(chunk) {
      let buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buffer.length - (buffer.length % 2);
      for (let offset = 0; offset < usable; offset += 2) push(buffer.readInt16LE(offset));
      carry = usable < buffer.length ? buffer.subarray(usable) : null;
    },
    finish() {
      if (count > 0) peaks.push(peakLevel(current));
      return Uint8Array.from(peaks);
    },
  };
}

export function computeWaveform(inputPath, { durationSeconds, ffmpegCommand = "ffmpeg", signal, spawnProcess = spawn } = {}) {
  const peaksPerSecond = waveformResolution(durationSeconds);
  const accumulator = createPeakAccumulator(WAVEFORM_SAMPLE_RATE / peaksPerSecond);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const child = spawnProcess(ffmpegCommand, [
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(WAVEFORM_SAMPLE_RATE), "-f", "s16le", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => accumulator.write(chunk));
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", (error) => { signal?.removeEventListener("abort", onAbort); reject(error); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(abortError());
      else if (code === 0) resolve({ peaksPerSecond, peaks: accumulator.finish() });
      else reject(new Error(`${ffmpegCommand} exited with code ${code} while reading audio.\n${stderr.trim()}`));
    });
  });
}
