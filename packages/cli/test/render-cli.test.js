import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";

const media = { duration: 10, width: 1920, height: 1080, frameRate: { numerator: 30, denominator: 1 }, audioChannels: 2 };

test("CLI --format mp4 renders the cut instead of writing a timeline", async () => {
  const writes = new Map(); const renders = [];
  const segments = [{ start: 1, end: 3, text: "И результаты оказались не очень." }, { start: 4, end: 7, text: "И результаты получились неочевидными." }];
  const result = await runCli(["/work/v.mov", "--format", "mp4", "--transcribe", "--project-resolution", "source"], { log: () => {}, dependencies: {
    access: async () => {}, probeMedia: async () => media, detectSilences: async () => [],
    transcribeMedia: async () => ({ language: "ru", text: "", segments, tokens: [], utterances: segments }),
    writeFile: async (file, data) => { writes.set(file, data); },
    renderVideo: async (input, output, options) => { renders.push({ input, output, keeps: options.keeps }); },
  } });
  assert.equal(result.outputPath, "/work/v.roughcut.mp4");
  assert.deepEqual(renders, [{ input: "/work/v.mov", output: "/work/v.roughcut.mp4", keeps: [{ start: 0, end: 1 }, { start: 3, end: 10 }] }]);
  assert.ok(!writes.has("/work/v.roughcut.mp4"), "no timeline document is written");
  assert.ok(writes.has("/work/v.roughcut.json"));
});
