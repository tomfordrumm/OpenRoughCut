import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installMissingDependencies } from "../src/runtime-dependencies.js";
import { run } from "#core/process.js";

const supported = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);
const target = `${process.platform}-${process.arch}`;
if (!supported.has(target)) throw new Error(`Runtime download smoke testing is not supported on ${target}.`);

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "roughcut-runtime-smoke-"));
const windows = process.platform === "win32";
const executables = windows ? ["ffmpeg.exe", "ffprobe.exe"] : ["ffmpeg"];
let lastBucket = -1;

try {
  await installMissingDependencies({
    platform: process.platform,
    arch: process.arch,
    runtimeDirectory: path.join(temporaryDirectory, "runtime", "bin"),
    modelsDirectory: path.join(temporaryDirectory, "models"),
    ffmpeg: { ready: false },
    ffprobe: { ready: !windows },
    model: { ready: true },
    vadModel: { ready: true },
  }, {
    onProgress: ({ received, total }) => {
      const bucket = Math.floor(received / total * 4);
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        console.log(`Download verification ${Math.min(100, bucket * 25)}%`);
      }
    },
  });
  for (const executable of executables) {
    const installed = path.join(temporaryDirectory, "runtime", "bin", executable);
    await run(installed, ["-version"]);
  }
  console.log(`Verified first-run editing-engine download for ${target}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
