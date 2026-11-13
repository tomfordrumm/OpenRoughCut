import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { keepsToSeconds, renderArguments, renderFilterGraph, renderVideo, videoBitrate } from "../src/render-video.js";

const media = { duration: 10, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioChannels: 2 };

test("kept frames become seconds and an ordered trim/concat graph with soft joins", () => {
  const keeps = keepsToSeconds([{ startFrame: 30, endFrame: 60 }, { startFrame: 150, endFrame: 165 }], media.frameRate);
  assert.deepEqual(keeps, [{ start: 1, end: 2 }, { start: 5, end: 5.5 }]);
  const graph = renderFilterGraph(keeps, { hasAudio: true, width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080 });
  assert.match(graph, /\[0:v:0\]trim=start=1:end=2,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(graph, /atrim=start=5:end=5\.5,asetpts=PTS-STARTPTS,afade=t=in:d=0\.005,afade=t=out:st=0\.495:d=0\.005\[a1\]/);
  assert.match(graph, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[vc\]\[aout\]/);
  assert.doesNotMatch(graph, /scale=/, "same size needs no scaling");
  const vertical = renderFilterGraph(keeps, { hasAudio: false, width: 1080, height: 1920, sourceWidth: 1920, sourceHeight: 1080 });
  assert.match(vertical, /scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920/);
  assert.doesNotMatch(vertical, /atrim/);
  assert.throws(() => renderFilterGraph([]), /entire recording/);
});

test("arguments pick the encoder and keep the source frame rate", () => {
  const args = renderArguments({ inputPath: "in.mov", outputPath: "out.mp4", graphPath: "g.txt", hasAudio: true, frameRate: { numerator: 30000, denominator: 1001 }, width: 3840, height: 2160, encoder: "videotoolbox" });
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 4), ["-c:v", "h264_videotoolbox", "-b:v", `${videoBitrate(3840, 2160, 29.97)}M`]);
  assert.ok(args.includes("30000/1001"));
  assert.ok(renderArguments({ inputPath: "a", outputPath: "b", graphPath: "g", hasAudio: false, frameRate: media.frameRate, width: 1, height: 1, encoder: "x264" }).includes("libx264"));
});

test("a failed hardware encode falls back to x264, and a failed render leaves no file", async () => {
  const calls = [];
  const out = "/tmp/orc-render-test.mp4";
  const runCommand = async (command, args) => {
    calls.push(args.includes("h264_videotoolbox") ? "videotoolbox" : "x264");
    if (calls.length === 1) throw new Error("VideoToolbox session failed");
    await writeFile(args.at(-1), Buffer.alloc(2000));
    return { stdout: "", stderr: "" };
  };
  const result = await renderVideo("in.mov", out, { keeps: [{ start: 0, end: 1 }], media, runCommand, platform: "darwin" });
  assert.deepEqual(calls, ["videotoolbox", "x264"]);
  assert.equal(result.durationSeconds, 1);
  await access(out);
  await assert.rejects(renderVideo("in.mov", "/tmp/orc-render-fail.mp4", { keeps: [{ start: 0, end: 1 }], media, runCommand: async () => { throw new Error("boom"); }, platform: "linux" }), /boom/);
  await assert.rejects(access("/tmp/orc-render-fail.mp4"));
});
