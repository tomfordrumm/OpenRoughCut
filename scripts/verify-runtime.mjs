import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

const requestedPlatform = process.argv[2] ?? process.platform;
const requestedArch = process.argv[3] ?? process.arch;
const supported = new Set(["darwin-arm64", "darwin-x64", "win32-x64"]);
const target = `${requestedPlatform}-${requestedArch}`;

if (!supported.has(target)) {
  throw new Error(`OpenRoughCut does not have a release runtime definition for ${target}.`);
}

const runtimeDirectory = path.resolve("vendor", target, "bin");
const required = requestedPlatform === "win32"
  ? [
      ["whisper-cli.exe", 100_000],
      ["whisper.dll", 100_000],
      ["ggml.dll", 50_000],
      ["ggml-base.dll", 100_000],
      ["ggml-cpu-x64.dll", 100_000],
    ]
  : [
      ["whisper-cli", 100_000],
    ];
const missing = [];

async function sha256(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

for (const [name, minimumBytes] of required) {
  const filePath = path.join(runtimeDirectory, name);
  try {
    await access(filePath);
    const info = await stat(filePath);
    if (!info.isFile() || info.size < minimumBytes) missing.push(filePath);
  } catch {
    missing.push(filePath);
  }
}

if (requestedPlatform === "win32") {
  const prerequisite = path.resolve("vendor", target, "prerequisites", "vc_redist.x64.exe");
  try {
    const info = await stat(prerequisite);
    if (!info.isFile() || info.size < 1_000_000) missing.push(prerequisite);
  } catch {
    missing.push(prerequisite);
  }
}

const manifestPath = path.resolve("vendor", target, "runtime-manifest.json");
try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.target !== target || !Array.isArray(manifest.components)) {
    missing.push(`${manifestPath} (invalid target or components)`);
  } else {
    for (const component of manifest.components) {
      if (component.distribution === "downloaded-by-user") continue;
      for (const [relativePath, expectedDigest] of Object.entries(component.files ?? {})) {
        const filePath = path.resolve("vendor", target, relativePath);
        try {
          if (await sha256(filePath) !== expectedDigest) missing.push(`${filePath} (checksum mismatch)`);
        } catch {
          missing.push(filePath);
        }
      }
    }
  }
} catch {
  missing.push(manifestPath);
}

if (missing.length) {
  throw new Error([
    `Cannot build the ${target} installer: its bundled runtime is incomplete.`,
    "Add the pinned redistributable components and prerequisites, or replace files that failed integrity checks:",
    ...missing.map((filePath) => `  - ${filePath}`),
    "See docs/RELEASING.md for the required layout and licensing checklist.",
  ].join("\n"));
}

console.log(`Verified bundled OpenRoughCut runtime for ${target}; the editing engine will be downloaded during first-run setup.`);
