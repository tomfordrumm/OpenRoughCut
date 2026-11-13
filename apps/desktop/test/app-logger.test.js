import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppLogger, errorDetails } from "../src/app-logger.js";

test("app logger writes structured diagnostic records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "roughcut-logger-test-"));
  try {
    const now = () => new Date("2026-07-22T10:00:00.000Z");
    const logger = createAppLogger({ directory, now });
    logger.info("video.open.selected", { sourcePath: "C:\\Videos\\clip.mp4" });
    logger.error("video.open.failed", Object.assign(new Error("No audio stream"), { code: "INVALID_MEDIA" }));

    const records = (await readFile(logger.filePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(records[0], {
      timestamp: "2026-07-22T10:00:00.000Z",
      level: "info",
      event: "video.open.selected",
      details: { sourcePath: "C:\\Videos\\clip.mp4" },
    });
    assert.equal(records[1].event, "video.open.failed");
    assert.equal(records[1].details.error.message, "No audio stream");
    assert.equal(records[1].details.error.code, "INVALID_MEDIA");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("app logger rotates a bounded previous log", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "roughcut-logger-rotation-test-"));
  try {
    const logger = createAppLogger({ directory, maxBytes: 180 });
    logger.info("first", { value: "a".repeat(100) });
    logger.info("second", { value: "b".repeat(100) });

    assert.match(await readFile(path.join(directory, "openroughcut.previous.log"), "utf8"), /"event":"first"/);
    assert.match(await readFile(logger.filePath, "utf8"), /"event":"second"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("errorDetails safely normalizes non-Error rejection reasons", () => {
  assert.deepEqual(errorDetails("failed"), { message: "failed" });
  assert.deepEqual(errorDetails(null), { message: "Unknown error" });
});
