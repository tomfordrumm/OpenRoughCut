import test from "node:test";
import assert from "node:assert/strict";
import { parseMediaTimecode } from "../src/media.js";

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
