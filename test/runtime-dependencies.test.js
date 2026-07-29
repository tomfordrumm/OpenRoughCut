import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadFile, EDITING_RUNTIME_DOWNLOADS, extractRuntimeFiles, installationPlan, MODEL_DOWNLOADS, TRANSCRIPTION_MODEL_DOWNLOADS } from "../src/runtime-dependencies.js";

test("runtime model downloads are pinned and integrity checked", () => {
  assert.deepEqual(TRANSCRIPTION_MODEL_DOWNLOADS.map((item) => item.id), ["base", "small", "large-v3-turbo"]);
  assert.deepEqual(MODEL_DOWNLOADS.map((item) => item.key), ["model", "model", "model", "vadModel"]);
  for (const item of MODEL_DOWNLOADS) {
    assert.match(item.url, /^https:\/\//);
    assert.doesNotMatch(item.url, /\/main\//);
    assert.ok(item.exactBytes > 100_000);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert.ok(item.fileName.endsWith(".bin"));
  }
});

test("editing runtime downloads are pinned for every release target", () => {
  assert.deepEqual(Object.keys(EDITING_RUNTIME_DOWNLOADS).sort(), ["darwin-arm64", "darwin-x64", "win32-x64"]);
  for (const [target, downloads] of Object.entries(EDITING_RUNTIME_DOWNLOADS)) {
    assert.ok(downloads.length > 0, `${target} has an archive`);
    for (const download of downloads) {
      assert.match(download.url, /^https:\/\//);
      assert.ok(download.exactBytes > 20_000_000);
      assert.match(download.sha256, /^[a-f0-9]{64}$/);
      assert.ok(download.files.length > 0);
      for (const file of download.files) {
        assert.ok(file.exactBytes > 50_000_000);
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
      }
    }
  }
});

test("installation plan includes only missing capabilities", () => {
  const plan = installationPlan({
    platform: "darwin",
    arch: "arm64",
    ffmpeg: { ready: false },
    ffprobe: { ready: true },
    selectedModelId: "small",
    model: { ready: false },
    vadModel: { ready: true },
  });
  assert.equal(plan.supported, true);
  assert.deepEqual(plan.archives.map((item) => item.key), ["ffmpeg-archive"]);
  assert.deepEqual(plan.models.map((item) => item.key), ["model"]);
  assert.equal(plan.exactBytes, 28_196_358 + 487_601_967);
});

test("downloadFile verifies content before replacing its destination", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "roughcut-download-test-"));
  try {
    const body = Buffer.from("verified runtime payload");
    const download = {
      key: "fixture",
      label: "test runtime",
      url: "https://example.invalid/runtime",
      exactBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    const destination = path.join(directory, "runtime.bin");
    const updates = [];
    await downloadFile(download, destination, {
      fetchImpl: async () => new Response(body, { headers: { "content-length": String(body.length) } }),
      onProgress: (update) => updates.push(update),
    });
    assert.deepEqual(await readFile(destination), body);
    assert.equal(updates.at(-1).received, body.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime extraction selects and verifies only the requested executable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "roughcut-extract-test-"));
  try {
    const body = Buffer.from("trusted executable fixture");
    const destination = path.join(directory, "output");
    await extractRuntimeFiles(path.join(directory, "fixture.zip"), [{
      key: "ffmpeg",
      entrySuffix: "/bin/ffmpeg",
      fileName: "ffmpeg",
      exactBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    }], destination, {
      platform: "darwin",
      runCommand: async (command, args) => {
        assert.equal(command, "/usr/bin/ditto");
        const extractedRoot = args.at(-1);
        await mkdir(path.join(extractedRoot, "release", "bin"), { recursive: true });
        await writeFile(path.join(extractedRoot, "release", "bin", "ffmpeg"), body);
        await writeFile(path.join(extractedRoot, "release", "README.txt"), "not selected");
      },
    });
    assert.deepEqual(await readFile(path.join(destination, "ffmpeg")), body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows runtime extraction passes complex paths in an encoded PowerShell command", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "roughcut-windows-extract-test-"));
  try {
    const body = Buffer.from("trusted Windows executable fixture");
    const archive = path.join(directory, "source user's ‘démo’.zip");
    const destination = path.join(directory, "output with spaces", "démo");
    await extractRuntimeFiles(archive, [{
      key: "ffmpeg",
      entrySuffix: "/bin/ffmpeg.exe",
      fileName: "ffmpeg.exe",
      exactBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    }], destination, {
      platform: "win32",
      runCommand: async (command, args) => {
        assert.equal(command, "powershell.exe");
        assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        assert.match(script, /\$ErrorActionPreference = 'Stop'/);
        assert.match(script, /\[Console\]::OutputEncoding/);
        const encodedPaths = [...script.matchAll(/FromBase64String\('([^']+)'\)/g)]
          .map((match) => Buffer.from(match[1], "base64").toString("utf16le"));
        assert.deepEqual(encodedPaths, [archive, path.join(destination, "archive")]);
        assert.equal(script.includes(archive), false);
        assert.match(script, /Expand-Archive -LiteralPath \$archivePath -DestinationPath \$archiveDirectory -Force/);
        const extractedRoot = path.join(destination, "archive");
        await mkdir(path.join(extractedRoot, "release", "bin"), { recursive: true });
        await writeFile(path.join(extractedRoot, "release", "bin", "ffmpeg.exe"), body);
      },
    });
    assert.deepEqual(await readFile(path.join(destination, "ffmpeg.exe")), body);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
