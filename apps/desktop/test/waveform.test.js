import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { computeWaveform, createPeakAccumulator, peakLevel, waveformResolution, MAX_WAVEFORM_PEAKS } from "../src/waveform.js";

const pcm = (samples) => { const b = Buffer.alloc(samples.length * 2); samples.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };

test("peak levels follow a dB curve from silence to full scale", () => {
  assert.equal(peakLevel(0), 0);
  assert.equal(peakLevel(32767), 255);
  assert.ok(peakLevel(3277) > 150 && peakLevel(3277) < 175, "−20 dB sits two thirds up");
  assert.equal(peakLevel(10), 0, "below −60 dB is drawn as silence");
});

test("the accumulator keeps the loudest sample per bucket across chunk boundaries", () => {
  const acc = createPeakAccumulator(2);
  const bytes = pcm([100, -32768, 5, 0, 32767]);
  acc.write(bytes.subarray(0, 3)); // split mid-sample
  acc.write(bytes.subarray(3));
  assert.deepEqual([...acc.finish()], [255, peakLevel(5), 255]);
});

test("resolution keeps long recordings under the peak budget", () => {
  assert.equal(waveformResolution(60), 100);
  for (const hours of [1, 3, 10]) assert.ok(hours * 3600 * waveformResolution(hours * 3600) <= MAX_WAVEFORM_PEAKS);
});

test("computeWaveform streams FFmpeg PCM and reports failures", async () => {
  const fake = (code, chunks) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    setImmediate(() => { for (const c of chunks) child.stdout.emit("data", c); child.stderr.emit("data", "bad"); child.emit("close", code); });
    return child;
  };
  const ok = await computeWaveform("a.mov", { durationSeconds: 1, spawnProcess: fake(0, [pcm(new Array(160).fill(32767))]) });
  assert.equal(ok.peaksPerSecond, 100);
  assert.deepEqual([...ok.peaks], [255, 255]);
  await assert.rejects(computeWaveform("a.mov", { durationSeconds: 1, spawnProcess: fake(1, []) }), /exited with code 1/);
});
