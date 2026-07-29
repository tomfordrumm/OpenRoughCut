import test from "node:test";
import assert from "node:assert/strict";
import { displayDimensions, parseMediaTimecode } from "../src/media.js";

test("uses display rotation when reporting portrait video dimensions", () => {
  assert.deepEqual(displayDimensions({
    width: 3840,
    height: 2160,
    side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
  }), { width: 2160, height: 3840 });
  assert.deepEqual(displayDimensions({
    width: 1920,
    height: 1080,
    tags: { rotate: "90" },
  }), { width: 1080, height: 1920 });
});

test("keeps encoded dimensions when display rotation does not change orientation", () => {
  assert.deepEqual(displayDimensions({ width: 3840, height: 2160 }), { width: 3840, height: 2160 });
  assert.deepEqual(displayDimensions({ width: 3840, height: 2160, side_data_list: [{ rotation: -180 }] }), { width: 3840, height: 2160 });
});

test("converts non-drop source timecode to absolute media frames", () => {
  assert.deepEqual(
    parseMediaTimecode("01:00:00:00", { numerator: 25, denominator: 1 }),
    { string: "01:00:00:00", frame: 90_000, displayFormat: "NDF" },
  );
  assert.deepEqual(
    parseMediaTimecode("01:00:00:00", { numerator: 30000, denominator: 1001 }),
    { string: "01:00:00:00", frame: 108_000, displayFormat: "NDF" },
  );
});

test("accounts for skipped frame numbers in NTSC drop-frame timecode", () => {
  assert.deepEqual(
    parseMediaTimecode("01:00:00;00", { numerator: 30000, denominator: 1001 }),
    { string: "01:00:00;00", frame: 107_892, displayFormat: "DF" },
  );
  assert.deepEqual(
    parseMediaTimecode("01:00:00;00", { numerator: 60000, denominator: 1001 }),
    { string: "01:00:00;00", frame: 215_784, displayFormat: "DF" },
  );
});

test("rejects malformed or rate-incompatible media timecodes", () => {
  assert.equal(parseMediaTimecode("01:00:00;00", { numerator: 25, denominator: 1 }), null);
  assert.equal(parseMediaTimecode("01:00:00:30", { numerator: 30000, denominator: 1001 }), null);
  assert.equal(parseMediaTimecode("not-a-timecode", { numerator: 25, denominator: 1 }), null);
});
