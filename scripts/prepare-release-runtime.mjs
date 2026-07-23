import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { downloadFile, extractRuntimeFiles } from "../src/runtime-dependencies.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const targetPlatform = process.argv[2] ?? process.platform;
const targetArch = process.argv[3] ?? process.arch;
const target = `${targetPlatform}-${targetArch}`;
const force = process.argv.includes("--force");

const runtimes = {
  "darwin-arm64": {
    archive: {
      key: "whisper-runtime",
      label: "pinned OpenRoughCut Apple Silicon runtime",
      fileName: "OpenRoughCut-0.1.1-mac-arm64.zip",
      exactBytes: 120_760_065,
      sha256: "3d7960a203d67fddcaef9d0ca6c7c905b9b1ca4f0ae6c1625c5b9f7c77836460",
      url: "https://github.com/tomfordrumm/OpenRoughCut/releases/download/v0.1.1/OpenRoughCut-0.1.1-mac-arm64.zip",
    },
    files: [
      { entrySuffix: "/Contents/Resources/runtime/bin/whisper-cli", fileName: "whisper-cli", exactBytes: 3_229_640, sha256: "141a693c5fdaf321e859465cc777ed72ea8fa64cdcb1d37b9dee27c2169ebf26" },
    ],
  },
  "darwin-x64": {
    archive: {
      key: "whisper-runtime",
      label: "pinned OpenRoughCut Intel runtime",
      fileName: "OpenRoughCut-0.1.1-mac-x64.zip",
      exactBytes: 122_746_547,
      sha256: "a33ec3a76b570544434b2508c4f2f3260f2a0b334bc8cb25a1c6a71e1bde1aae",
      url: "https://github.com/tomfordrumm/OpenRoughCut/releases/download/v0.1.1/OpenRoughCut-0.1.1-mac-x64.zip",
    },
    files: [
      { entrySuffix: "/Contents/Resources/runtime/bin/whisper-cli", fileName: "whisper-cli", exactBytes: 3_721_512, sha256: "436960a65e1c76f4c9291da81fc1ed78e93b3c0ba528cae8c527d1d0e0a4545d" },
    ],
  },
  "win32-x64": {
    archive: {
      key: "whisper-runtime",
      label: "whisper.cpp Windows runtime",
      fileName: "whisper-bin-x64.zip",
      exactBytes: 7_982_101,
      sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
      url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip",
    },
    files: [
      { entrySuffix: "/whisper-cli.exe", fileName: "whisper-cli.exe", exactBytes: 479_232, sha256: "58245314fb73b30fbd0cf0542c5c172e23f02b6eb7cad7b51e792439cf5e1755" },
      { entrySuffix: "/whisper.dll", fileName: "whisper.dll", exactBytes: 1_366_016, sha256: "b31690c12461517fe9774e61318ab63a69972b948151feed98b913be35f708b6" },
      { entrySuffix: "/ggml.dll", fileName: "ggml.dll", exactBytes: 67_584, sha256: "db753141098018ab482796052a61e727ee0106cbc280f28397f6a111b5e667d7" },
      { entrySuffix: "/ggml-base.dll", fileName: "ggml-base.dll", exactBytes: 656_384, sha256: "8be6f3e06388b3a9aac75d29bec86363e2e2f5b0cee86ce6438866bcac0bcf86" },
      { entrySuffix: "/ggml-cpu-alderlake.dll", fileName: "ggml-cpu-alderlake.dll", exactBytes: 790_528, sha256: "323408503da53ccc67248b26d711f16d73d2d6239f7703a00a6a18b60ed5b8b8" },
      { entrySuffix: "/ggml-cpu-cannonlake.dll", fileName: "ggml-cpu-cannonlake.dll", exactBytes: 833_536, sha256: "0f659d98b823bb871c7845787bba7485facd220099cf58aa773652b9b842ab2e" },
      { entrySuffix: "/ggml-cpu-cascadelake.dll", fileName: "ggml-cpu-cascadelake.dll", exactBytes: 830_976, sha256: "8116b0e516134139de29400c536ecf06fe708ce1a078a96d30b562b30d524fbe" },
      { entrySuffix: "/ggml-cpu-haswell.dll", fileName: "ggml-cpu-haswell.dll", exactBytes: 791_552, sha256: "e5925923a47672392f9e9c8c92e4b9b65ea473948bf4f568a0300a3a42485135" },
      { entrySuffix: "/ggml-cpu-icelake.dll", fileName: "ggml-cpu-icelake.dll", exactBytes: 830_976, sha256: "b726d528bee0c811c6b2ad8775357379d651cabb487bbf800331697fe73da187" },
      { entrySuffix: "/ggml-cpu-sandybridge.dll", fileName: "ggml-cpu-sandybridge.dll", exactBytes: 783_360, sha256: "1c49c64817233b2447ca305b41c66afa4bed31b058bc190a98af2a30cc703542" },
      { entrySuffix: "/ggml-cpu-skylakex.dll", fileName: "ggml-cpu-skylakex.dll", exactBytes: 833_536, sha256: "06082dc62a09a82fbba4aab49b2c049b96db84c5fc561a446a8ddbfb9b20bf86" },
      { entrySuffix: "/ggml-cpu-sse42.dll", fileName: "ggml-cpu-sse42.dll", exactBytes: 772_096, sha256: "9a8f55ff1dfad231aa6250ac52c330c5bfa5c4c37691c8b591a68b52090ce40c" },
      { entrySuffix: "/ggml-cpu-x64.dll", fileName: "ggml-cpu-x64.dll", exactBytes: 776_704, sha256: "45ff644d301b8a1fffc7c5e3864205047360eb197814c7311f366d106bb5b19f" },
    ],
    prerequisite: {
      key: "vc-runtime",
      label: "Microsoft Visual C++ Redistributable",
      fileName: "vc_redist.x64.exe",
      exactBytes: 18_731_856,
      sha256: "843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c",
      url: "https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe",
    },
  },
};

const runtime = runtimes[target];
if (!runtime) throw new Error(`Release runtime preparation is not supported for ${target}.`);
if (process.platform !== targetPlatform) throw new Error(`${target} release runtime must be prepared on ${targetPlatform}.`);

async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function matches(filePath, expectedBytes, expectedDigest) {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size === expectedBytes && await sha256(filePath) === expectedDigest;
  } catch {
    return false;
  }
}

const binDirectory = path.join(projectRoot, "vendor", target, "bin");
const prerequisiteDirectory = path.join(projectRoot, "vendor", target, "prerequisites");
const expectedFiles = runtime.files.map((file) => ({ ...file, destination: path.join(binDirectory, file.fileName) }));
if (runtime.prerequisite) expectedFiles.push({ ...runtime.prerequisite, destination: path.join(prerequisiteDirectory, runtime.prerequisite.fileName) });

if (!force && (await Promise.all(expectedFiles.map((file) => matches(file.destination, file.exactBytes, file.sha256)))).every(Boolean)) {
  console.log(`Pinned release runtime for ${target} is already prepared.`);
  process.exit(0);
}

const stagingDirectory = await mkdtemp(path.join(os.tmpdir(), `openroughcut-${target}-`));
try {
  const archivePath = path.join(stagingDirectory, runtime.archive.fileName);
  const extractedDirectory = path.join(stagingDirectory, "extracted");
  await downloadFile(runtime.archive, archivePath);
  await extractRuntimeFiles(archivePath, runtime.files, extractedDirectory, { platform: targetPlatform });
  await mkdir(binDirectory, { recursive: true });
  for (const file of runtime.files) {
    const destination = path.join(binDirectory, file.fileName);
    await copyFile(path.join(extractedDirectory, file.fileName), destination);
    if (targetPlatform !== "win32") await chmod(destination, 0o755);
  }
  if (runtime.prerequisite) {
    await mkdir(prerequisiteDirectory, { recursive: true });
    await downloadFile(runtime.prerequisite, path.join(prerequisiteDirectory, runtime.prerequisite.fileName));
  }
  console.log(`Prepared pinned release runtime for ${target}.`);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
