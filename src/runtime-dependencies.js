import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { run } from "./process.js";
import { DEFAULT_TRANSCRIPTION_MODEL_ID, TRANSCRIPTION_MODEL_OPTIONS, normalizeTranscriptionModelId } from "./transcription-models.js";

export const TRANSCRIPTION_MODEL_DOWNLOADS = [
  {
    id: "base",
    key: "model",
    fileName: "ggml-base.bin",
    label: "Whisper multilingual base model",
    exactBytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/80da2d8bfee42b0e836fc3a9890373e5defc00a6/ggml-base.bin",
  },
  {
    id: "small",
    key: "model",
    fileName: "ggml-small.bin",
    label: "Whisper multilingual small model",
    exactBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin",
  },
  {
    id: "large-v3-turbo",
    key: "model",
    fileName: "ggml-large-v3-turbo.bin",
    label: "Whisper multilingual Large-v3 Turbo model",
    exactBytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo.bin",
  },
];

export const VAD_MODEL_DOWNLOAD =
  {
    key: "vadModel",
    fileName: "ggml-silero-v6.2.0.bin",
    label: "Silero speech detector",
    exactBytes: 885_098,
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin",
  };

export const MODEL_DOWNLOADS = [...TRANSCRIPTION_MODEL_DOWNLOADS, VAD_MODEL_DOWNLOAD];

function transcriptionModelDownload(modelId) {
  const normalized = normalizeTranscriptionModelId(modelId);
  return TRANSCRIPTION_MODEL_DOWNLOADS.find((download) => download.id === normalized);
}

export const EDITING_RUNTIME_DOWNLOADS = {
  "darwin-arm64": [
    {
      key: "ffmpeg-archive",
      label: "editing engine",
      fileName: "ffmpeg.zip",
      exactBytes: 28_196_358,
      sha256: "ef1aa60006c7b77ce170c1608c08d8e4ba1c30c5746f2ac986ded932d0ac2c3c",
      url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffmpeg.zip",
      files: [{ key: "ffmpeg", entrySuffix: "/ffmpeg", fileName: "ffmpeg", exactBytes: 65_637_248, sha256: "eaf91238e104dd0e262bc6510e25061855cc99a6955a721b0ac99660d58c473d" }],
    },
    {
      key: "ffprobe-archive",
      label: "media inspector",
      fileName: "ffprobe.zip",
      exactBytes: 28_118_222,
      sha256: "c39787f4af7a3932502d2d48db6f6feaaa836b48a73ef78c32cc3285df61dfaf",
      url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1783011502_8.1.2/ffprobe.zip",
      files: [{ key: "ffprobe", entrySuffix: "/ffprobe", fileName: "ffprobe", exactBytes: 65_445_840, sha256: "ed9dc5871914b466b96b402c9ec0ba68ce4f836e72faa464b1b4e279835bd4a6" }],
    },
  ],
  "darwin-x64": [
    {
      key: "ffmpeg-archive",
      label: "editing engine",
      fileName: "ffmpeg.zip",
      exactBytes: 33_586_778,
      sha256: "a52ef43883f44c219766d4b3bdde4e635b35465d0b704c01c3a0566b59775df9",
      url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1783018342_8.1.2/ffmpeg.zip",
      files: [{ key: "ffmpeg", entrySuffix: "/ffmpeg", fileName: "ffmpeg", exactBytes: 93_980_912, sha256: "1ca59dda73668c59898a0b305afd8a88817a989187f222ec62d64e775d614d23" }],
    },
    {
      key: "ffprobe-archive",
      label: "media inspector",
      fileName: "ffprobe.zip",
      exactBytes: 33_477_267,
      sha256: "5408ca588c8c72b0dde3afe676d0a7acf25ef97e55ae6eba5c7bede1cda42695",
      url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1783018342_8.1.2/ffprobe.zip",
      files: [{ key: "ffprobe", entrySuffix: "/ffprobe", fileName: "ffprobe", exactBytes: 93_772_560, sha256: "bdb6aff0f1f414382effd97040f7862dc85e67996ac296cb4288beed0e06498f" }],
    },
  ],
  "win32-x64": [
    {
      key: "ffmpeg-archive",
      label: "editing engine",
      fileName: "ffmpeg-8.1.2-essentials_build.zip",
      exactBytes: 109_728_040,
      sha256: "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec",
      url: "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip",
      files: [
        { key: "ffmpeg", entrySuffix: "/bin/ffmpeg.exe", fileName: "ffmpeg.exe", exactBytes: 101_897_728, sha256: "1326dde4c84ff1f96fe6b8916c5bed29e163e9b5dccf995f6f3db069d143ec5e" },
        { key: "ffprobe", entrySuffix: "/bin/ffprobe.exe", fileName: "ffprobe.exe", exactBytes: 101_692_928, sha256: "b49ccc7c6547b141ad5a2f6ec69cc04323d7133d7704d70b331b904c63eecb07" },
      ],
    },
  ],
};

function executableName(name, platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

async function usableFile(filePath, expectedBytes = null) {
  try {
    const info = await stat(filePath);
    return info.isFile() && (expectedBytes === null ? info.size > 0 : info.size === expectedBytes);
  } catch {
    return false;
  }
}

async function usableCommand(command, args) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await run(command, args, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCommand(name, args, { resourcesPath, runtimeDirectory, developmentRuntimeDirectory, platform }) {
  const executable = executableName(name, platform);
  const candidates = [
    { command: path.join(runtimeDirectory, executable), source: "downloaded" },
    { command: path.join(resourcesPath, "runtime", "bin", executable), source: "bundled" },
    developmentRuntimeDirectory ? { command: path.join(developmentRuntimeDirectory, executable), source: "development" } : null,
    { command: executable, source: "system" },
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.source !== "system" && !await usableFile(candidate.command)) continue;
    if (await usableCommand(candidate.command, args)) return { ready: true, ...candidate };
  }
  return { ready: false, command: null, source: null };
}

async function resolveModel(download, { resourcesPath, modelsDirectory, developmentModelsDirectory }) {
  const candidates = [
    { filePath: path.join(modelsDirectory, download.fileName), source: "downloaded" },
    { filePath: path.join(resourcesPath, "runtime", "models", download.fileName), source: "bundled" },
    developmentModelsDirectory ? { filePath: path.join(developmentModelsDirectory, download.fileName), source: "development" } : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await usableFile(candidate.filePath, download.exactBytes)) return { ready: true, path: candidate.filePath, source: candidate.source };
  }
  return { ready: false, path: path.join(modelsDirectory, download.fileName), source: null };
}

export function installationPlan(status) {
  const target = `${status.platform}-${status.arch}`;
  const runtimeDownloads = EDITING_RUNTIME_DOWNLOADS[target] ?? [];
  const archives = runtimeDownloads.filter((download) => download.files.some((file) => !status[file.key]?.ready));
  const selectedModel = transcriptionModelDownload(status.selectedModelId);
  const models = [
    ...(!status.model?.ready ? [selectedModel] : []),
    ...(!status.vadModel?.ready ? [VAD_MODEL_DOWNLOAD] : []),
  ];
  return {
    target,
    supported: Boolean(EDITING_RUNTIME_DOWNLOADS[target]),
    archives,
    models,
    exactBytes: [...archives, ...models].reduce((total, item) => total + item.exactBytes, 0),
  };
}

export async function inspectRuntimeDependencies({ resourcesPath, userDataPath, developmentRoot = null, platform = process.platform, arch = process.arch, selectedModelId = DEFAULT_TRANSCRIPTION_MODEL_ID }) {
  const normalizedModelId = normalizeTranscriptionModelId(selectedModelId);
  const modelsDirectory = path.join(userDataPath, "models");
  const runtimeDirectory = path.join(userDataPath, "runtime", "bin");
  const developmentModelsDirectory = developmentRoot ? path.join(developmentRoot, ".models") : null;
  const developmentRuntimeDirectory = developmentRoot ? path.join(developmentRoot, "vendor", `${platform}-${arch}`, "bin") : null;
  const commandOptions = { resourcesPath, runtimeDirectory, developmentRuntimeDirectory, platform };
  const [ffmpeg, ffprobe, whisper, resolvedModels, vadModel] = await Promise.all([
    resolveCommand("ffmpeg", ["-version"], commandOptions),
    resolveCommand("ffprobe", ["-version"], commandOptions),
    resolveCommand("whisper-cli", ["-h"], commandOptions),
    Promise.all(TRANSCRIPTION_MODEL_DOWNLOADS.map((download) => resolveModel(download, { resourcesPath, modelsDirectory, developmentModelsDirectory }))),
    resolveModel(VAD_MODEL_DOWNLOAD, { resourcesPath, modelsDirectory, developmentModelsDirectory }),
  ]);
  const models = TRANSCRIPTION_MODEL_OPTIONS.map((option, index) => ({
    ...option,
    exactBytes: TRANSCRIPTION_MODEL_DOWNLOADS[index].exactBytes,
    ...resolvedModels[index],
  }));
  const model = models.find((option) => option.id === normalizedModelId);
  const status = {
    platform,
    arch,
    modelsDirectory,
    runtimeDirectory,
    ffmpeg,
    ffprobe,
    whisper,
    selectedModelId: normalizedModelId,
    models,
    model,
    vadModel,
    coreReady: ffmpeg.ready && ffprobe.ready,
    transcriptionReady: ffmpeg.ready && whisper.ready && model.ready && vadModel.ready,
  };
  const plan = installationPlan(status);
  return { ...status, canInstall: plan.supported && (plan.archives.length > 0 || plan.models.length > 0), installBytes: plan.exactBytes };
}

export async function downloadFile(download, destination, { signal, onProgress, fetchImpl = fetch } = {}) {
  const temporary = `${destination}.partial`;
  await mkdir(path.dirname(destination), { recursive: true });
  await unlink(temporary).catch(() => {});
  let response;
  try {
    response = await fetchImpl(download.url, { signal, redirect: "follow" });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    throw new Error(`Could not download ${download.label}. Check your internet connection and try again.`, { cause: error });
  }
  if (!response.ok || !response.body) throw new Error(`Could not download ${download.label} (${response.status}).`);
  const reportedTotal = Number(response.headers.get("content-length")) || null;
  if (reportedTotal !== null && reportedTotal !== download.exactBytes) throw new Error(`${download.label} reported an unexpected size.`);
  const handle = await open(temporary, "w");
  let received = 0;
  const digest = createHash("sha256");
  let downloadError = null;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      digest.update(value);
      received += value.byteLength;
      if (received > download.exactBytes) throw new Error(`${download.label} exceeded its expected size.`);
      onProgress?.({ stage: "download", key: download.key, label: download.label, received, total: download.exactBytes });
    }
  } catch (error) {
    downloadError = error;
  } finally {
    await handle.close();
  }
  if (downloadError) {
    await unlink(temporary).catch(() => {});
    throw downloadError;
  }
  if (received !== download.exactBytes || digest.digest("hex") !== download.sha256) {
    await unlink(temporary).catch(() => {});
    throw new Error(`${download.label} failed its integrity check.`);
  }
  await unlink(destination).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await rename(temporary, destination);
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : entry.isFile() ? [entryPath] : [];
  }));
  return nested.flat();
}

function utf16Base64(value) {
  return Buffer.from(value, "utf16le").toString("base64");
}

export async function extractRuntimeFiles(archivePath, files, destinationDirectory, { platform = process.platform, signal, runCommand = run } = {}) {
  await mkdir(destinationDirectory, { recursive: true });
  const archiveDirectory = path.join(destinationDirectory, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  if (platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      `$archivePath = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${utf16Base64(archivePath)}'))`,
      `$archiveDirectory = [System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${utf16Base64(archiveDirectory)}'))`,
      "Expand-Archive -LiteralPath $archivePath -DestinationPath $archiveDirectory -Force",
    ].join("; ");
    await runCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      utf16Base64(command),
    ], { signal });
  } else {
    await runCommand("/usr/bin/ditto", ["-x", "-k", archivePath, archiveDirectory], { signal });
  }
  const extractedFiles = await filesBelow(archiveDirectory);
  for (const file of files) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    const normalizedSuffix = file.entrySuffix.replaceAll("\\", "/");
    const extracted = extractedFiles.find((candidate) => `/${path.relative(archiveDirectory, candidate).replaceAll(path.sep, "/")}`.endsWith(normalizedSuffix));
    if (!extracted) throw new Error(`The downloaded archive does not contain ${file.fileName}.`);
    const destination = path.join(destinationDirectory, file.fileName);
    await rename(extracted, destination);
    const info = await stat(destination);
    if (info.size !== file.exactBytes || await sha256File(destination) !== file.sha256) throw new Error(`${file.fileName} failed its integrity check.`);
    if (platform !== "win32") await chmod(destination, 0o755);
  }
}

async function installRuntimeArchive(download, status, { signal, onProgress }) {
  const runtimeRoot = path.dirname(status.runtimeDirectory);
  await mkdir(runtimeRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(runtimeRoot, ".install-"));
  try {
    const archivePath = path.join(stagingDirectory, download.fileName);
    await downloadFile(download, archivePath, { signal, onProgress });
    const missingFiles = download.files.filter((file) => !status[file.key]?.ready);
    const extractedDirectory = path.join(stagingDirectory, "extracted");
    onProgress?.({ stage: "install", key: download.key, label: download.label, received: download.exactBytes, total: download.exactBytes });
    await extractRuntimeFiles(archivePath, missingFiles, extractedDirectory, { platform: status.platform, signal });
    await mkdir(status.runtimeDirectory, { recursive: true });
    for (const file of missingFiles) {
      const destination = path.join(status.runtimeDirectory, file.fileName);
      await unlink(destination).catch((error) => { if (error.code !== "ENOENT") throw error; });
      await rename(path.join(extractedDirectory, file.fileName), destination);
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function installMissingDependencies(status, { signal, onProgress } = {}) {
  const plan = installationPlan(status);
  if (!plan.supported && (!status.coreReady || plan.models.length > 0)) throw new Error(`Automatic setup is not available for ${plan.target}.`);
  let completedBytes = 0;
  const report = (item) => onProgress?.({
    ...item,
    received: completedBytes + item.received,
    total: plan.exactBytes,
    currentReceived: item.received,
    currentTotal: item.total,
  });
  for (const download of plan.archives) {
    await installRuntimeArchive(download, status, { signal, onProgress: report });
    completedBytes += download.exactBytes;
  }
  for (const download of plan.models) {
    await downloadFile(download, path.join(status.modelsDirectory, download.fileName), { signal, onProgress: report });
    completedBytes += download.exactBytes;
  }
}

export async function installMissingModels(status, options = {}) {
  const modelsOnly = { ...status, ffmpeg: { ready: true }, ffprobe: { ready: true } };
  return installMissingDependencies(modelsOnly, options);
}

export async function assertRuntimeFile(filePath) {
  await access(filePath);
  return filePath;
}
