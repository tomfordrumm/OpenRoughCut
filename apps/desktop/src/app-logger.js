import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function errorDetails(error) {
  if (!error) return { message: "Unknown error" };
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
    cause: error.cause ? errorDetails(error.cause) : undefined,
  };
}

export function createAppLogger({ directory, maxBytes = DEFAULT_MAX_BYTES, now = () => new Date() }) {
  const filePath = path.join(directory, "openroughcut.log");
  const previousFilePath = path.join(directory, "openroughcut.previous.log");

  const rotateIfNeeded = (incomingBytes) => {
    let currentBytes = 0;
    try { currentBytes = statSync(filePath).size; } catch {}
    if (currentBytes + incomingBytes <= maxBytes) return;
    try { rmSync(previousFilePath, { force: true }); } catch {}
    try { renameSync(filePath, previousFilePath); } catch {}
  };

  const write = (level, event, details = undefined) => {
    try {
      mkdirSync(directory, { recursive: true });
      const record = { timestamp: now().toISOString(), level, event };
      if (details !== undefined) record.details = details;
      const line = `${JSON.stringify(record)}\n`;
      rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(filePath, line, "utf8");
    } catch {
      // Diagnostics must never interfere with the editing workflow.
    }
  };

  return {
    filePath,
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, error, details = {}) => write("error", event, { ...details, error: errorDetails(error) }),
  };
}
