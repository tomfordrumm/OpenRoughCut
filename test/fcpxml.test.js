import test from "node:test";
import assert from "node:assert/strict";
import { createFcpxml, frameTime, predefinedFormatName } from "../src/fcpxml.js";

const ntsc = { numerator: 30000, denominator: 1001 };

test("represents frame times as exact reduced FCPXML rationals", () => {
  assert.equal(frameTime(1, ntsc), "1001/30000s");
  assert.equal(frameTime(30, ntsc), "1001/1000s");
  assert.equal(frameTime(0, ntsc), "0s");
});

test("uses Final Cut's named formats for standard project resolutions", () => {
  assert.equal(predefinedFormatName({ width: 1920, height: 1080 }, { numerator: 30, denominator: 1 }), "FFVideoFormat1080p30");
  assert.equal(predefinedFormatName({ width: 3840, height: 2160 }, ntsc), "FFVideoFormat3840x2160p2997");
  assert.equal(predefinedFormatName({ width: 3840, height: 1080 }, { numerator: 30, denominator: 1 }), null);
});

test("creates sequential clips referencing exact source ranges", () => {
  const document = createFcpxml({
    inputPath: "/tmp/A & B.mov",
    clipName: "A & B.mov",
    compoundName: "A & B — Source",
    projectName: "A & B — Rough Cut",
    media: {
      duration: 10,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 25, denominator: 1 },
      audioChannels: 2,
      audioRate: 48000,
    },
    projectResolution: { width: 3840, height: 2160 },
    keeps: [
      { startFrame: 0, endFrame: 50 },
      { startFrame: 100, endFrame: 250 },
    ],
  });

  assert.match(document, /<fcpxml version="1\.10">/);
  assert.match(document, /<format id="r1" name="FFVideoFormat1080p25"\/>/);
  assert.match(document, /<format id="r3" name="FFVideoFormat3840x2160p25"\/>/);
  assert.match(document, /src="file:\/\/\/tmp\/A%20&amp;%20B\.mov"/);
  assert.match(document, /<media id="r4" name="A &amp; B — Source">[\s\S]*<sequence format="r3" duration="10s"/);
  assert.match(document, /<asset-clip name="A &amp; B\.mov" ref="r2" offset="0s" start="0s" duration="10s" audioRole="dialogue"\/>/);
  assert.match(document, /<event name="OpenRoughCut">\s*<ref-clip name="A &amp; B — Source" ref="r4" start="0s" duration="10s"\/>/);
  assert.match(document, /name="A &amp; B — Source" ref="r4" offset="0s" start="0s" duration="2s"/);
  assert.match(document, /name="A &amp; B — Source" ref="r4" offset="2s" start="4s" duration="6s"/);
  assert.match(document, /<sequence format="r3" duration="8s"/);
});
