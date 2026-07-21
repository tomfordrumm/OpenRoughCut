import test from "node:test";
import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createMediaResponse, parseByteRange } from "../src/media-stream.js";

test("parses open, closed, and suffix byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseByteRange("bytes=100-120", 100), false);
  assert.equal(parseByteRange("bytes=1-2,4-5", 100), false);
});

test("serves an MP4 byte range with Chromium-compatible headers", async (context) => {
  const filePath = path.join(tmpdir(), `${randomUUID()}.mp4`);
  context.after(() => unlink(filePath).catch(() => {}));
  await writeFile(filePath, Buffer.from("0123456789abcdef"));
  const response = await createMediaResponse(new Request("https://media.test/video", { headers: { Range: "bytes=4-9" } }), filePath);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-range"), "bytes 4-9/16");
  assert.equal(response.headers.get("content-length"), "6");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "456789");
});

test("rejects an unsatisfiable byte range", async (context) => {
  const filePath = path.join(tmpdir(), `${randomUUID()}.mp4`);
  context.after(() => unlink(filePath).catch(() => {}));
  await writeFile(filePath, Buffer.from("short"));
  const response = await createMediaResponse(new Request("https://media.test/video", { headers: { Range: "bytes=20-" } }), filePath);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), "bytes */5");
});
