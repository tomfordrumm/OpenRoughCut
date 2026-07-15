import test from "node:test";
import assert from "node:assert/strict";
import { isStandardResolution, resolveProjectResolution } from "../src/resolution.js";

test("recognizes common Final Cut project dimensions", () => {
  assert.equal(isStandardResolution({ width: 1920, height: 1080 }), true);
  assert.equal(isStandardResolution({ width: 3840, height: 2160 }), true);
  assert.equal(isStandardResolution({ width: 3840, height: 1080 }), false);
});

test("resolves source, UHD 4K, and Full HD choices", () => {
  const media = { width: 3840, height: 1080 };
  assert.deepEqual(resolveProjectResolution(media, "source"), { width: 3840, height: 1080, choice: "source" });
  assert.deepEqual(resolveProjectResolution(media, "4k"), { width: 3840, height: 2160, choice: "4k" });
  assert.deepEqual(resolveProjectResolution(media, "full-hd"), { width: 1920, height: 1080, choice: "full-hd" });
});

test("rejects unsupported non-interactive choices", () => {
  assert.throws(
    () => resolveProjectResolution({ width: 1920, height: 1080 }, "cinema"),
    /must be source, 4k, or full-hd/,
  );
});
