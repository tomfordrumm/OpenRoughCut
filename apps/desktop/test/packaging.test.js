import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageDocument = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const installerScript = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
const releaseStagingScript = await readFile(new URL("../scripts/stage-release.mjs", import.meta.url), "utf8");
const cliPackage = JSON.parse(await readFile(new URL("../../../packages/cli/package.json", import.meta.url), "utf8"));

test("release identity is OpenRoughCut 0.1.3", () => {
  assert.equal(packageDocument.name, "openroughcut");
  assert.equal(packageDocument.version, "0.1.3");
  assert.equal(cliPackage.bin.openroughcut, "./src/cli.js");
  assert.equal(packageDocument.build.appId, "com.openroughcut.editor");
  assert.equal(packageDocument.build.productName, "OpenRoughCut");
});

test("installers bundle Whisper but never convey FFmpeg executables", () => {
  const macResources = packageDocument.build.mac.extraResources;
  assert.ok(macResources.some((item) => item.from.endsWith("/bin/whisper-cli")));
  assert.equal(macResources.some((item) => /\/bin\/(ffmpeg|ffprobe)$/.test(item.from)), false);

  const windowsRuntime = packageDocument.build.win.extraResources.find((item) => item.to === "runtime/bin");
  assert.ok(windowsRuntime);
  assert.ok(windowsRuntime.filter.includes("whisper-cli.exe"));
  assert.equal(windowsRuntime.filter.some((item) => /^ffmpeg|^ffprobe/.test(item)), false);
});

test("Windows uses a one-click per-user installer", () => {
  assert.equal(packageDocument.build.nsis.oneClick, true);
  assert.equal(packageDocument.build.nsis.perMachine, false);
  assert.equal(packageDocument.build.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(packageDocument.build.nsis.runAfterFinish, true);
});

test("Windows stages its installer prerequisite without parent-directory traversal", () => {
  assert.match(packageDocument.scripts["dist:win"], /stage-release\.mjs win32/);
  assert.match(releaseStagingScript, /installer-prerequisites/);
  assert.match(installerScript, /\$\{PROJECT_DIR\}\\installer-prerequisites\\vc_redist\.x64\.exe/);
  assert.doesNotMatch(installerScript, /PROJECT_DIR[^\r\n]*\.\.\/vendor/);
});

test("candidate configuration cannot notarize or publish on a tag push", async () => {
  for (const [name, command] of Object.entries(packageDocument.scripts)) {
    if (name === "dist" || name.startsWith("dist:")) assert.match(command, /--publish never/);
  }
  assert.equal(packageDocument.build.mac.notarize, false);
  assert.equal(packageDocument.build.mac.hardenedRuntime, true);
  assert.ok(packageDocument.build.mac.binaries.includes("Contents/Resources/runtime/bin/whisper-cli"));
  const workflow = await readFile(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /gh release create|contents: write|\n  push:/);
  const candidate = await readFile(new URL('../scripts/macos-candidate.sh', import.meta.url), 'utf8');
  assert.match(candidate, /--publish never/);
  assert.match(candidate, /forceCodeSigning=true/);
  assert.doesNotMatch(candidate, /notarytool submit/);
});
