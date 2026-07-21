import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4": return "video/mp4";
    case ".m4v": return "video/x-m4v";
    case ".mov": return "video/quicktime";
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    default: return "application/octet-stream";
  }
}

export function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function streamBody(filePath, start, end, signal) {
  const stream = createReadStream(filePath, { start, end });
  if (signal) {
    if (signal.aborted) stream.destroy();
    else signal.addEventListener("abort", () => stream.destroy(), { once: true });
  }
  return Readable.toWeb(stream);
}

export async function createMediaResponse(request, filePath) {
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return new Response("Media not found", { status: 404 });
    throw error;
  }
  if (!fileInfo.isFile()) return new Response("Media not found", { status: 404 });

  const baseHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType(filePath),
    "Cache-Control": "private, max-age=3600",
  };
  const range = parseByteRange(request.headers.get("range"), fileInfo.size);
  if (range === false) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${fileInfo.size}` } });
  }
  if (range) {
    const headers = {
      ...baseHeaders,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${fileInfo.size}`,
    };
    return new Response(request.method === "HEAD" ? null : streamBody(filePath, range.start, range.end, request.signal), { status: 206, headers });
  }
  return new Response(request.method === "HEAD" ? null : streamBody(filePath, 0, fileInfo.size - 1, request.signal), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(fileInfo.size) },
  });
}
