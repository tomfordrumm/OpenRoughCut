import test from "node:test";
import assert from "node:assert/strict";
import { createPremiereXml, premiereRate } from "../src/premiere-xml.js";

test("maps integer and NTSC fractional frame rates to Premiere XML rates", () => {
  assert.deepEqual(premiereRate({ numerator: 25, denominator: 1 }), { timebase: 25, ntsc: false });
  assert.deepEqual(premiereRate({ numerator: 30000, denominator: 1001 }), { timebase: 30, ntsc: true });
  assert.throws(() => premiereRate({ numerator: 100, denominator: 3 }), /1000\/1001/);
});

test("creates linked Premiere video and audio clip items with exact source ranges", () => {
  const document = createPremiereXml({
    inputPath: "/tmp/A & B.mov",
    clipName: "A & B.mov",
    projectName: "A & B — Rough Cut",
    media: {
      duration: 10,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 30000, denominator: 1001 },
      audioChannels: 2,
      audioRate: 48000,
      audioLayout: "stereo",
      sourceTimecode: "01:00:00;00",
      sourceStartFrame: 107892,
      sourceTimecodeDisplayFormat: "DF",
    },
    projectResolution: { width: 3840, height: 2160 },
    keeps: [
      { startFrame: 0, endFrame: 60 },
      { startFrame: 120, endFrame: 300 },
    ],
  });

  assert.match(document, /<xmeml version="5">/);
  assert.match(document, /<pathurl>file:\/\/\/tmp\/A%20&amp;%20B\.mov<\/pathurl>/);
  assert.match(document, /<name>A &amp; B — Rough Cut<\/name>\s*<duration>240<\/duration>/);
  assert.match(document, /<width>3840<\/width>\s*<height>2160<\/height>/);
  assert.match(document, /<clipitem id="clipitem-v-1">[\s\S]*?<start>0<\/start>\s*<end>60<\/end>\s*<in>0<\/in>\s*<out>60<\/out>/);
  assert.match(document, /<clipitem id="clipitem-v-2">[\s\S]*?<start>60<\/start>\s*<end>240<\/end>\s*<in>120<\/in>\s*<out>300<\/out>/);
  assert.match(document, /<clipitem id="clipitem-a1-2">[\s\S]*?<sourcetrack>\s*<mediatype>audio<\/mediatype>\s*<trackindex>1<\/trackindex>/);
  assert.match(document, /<clipitem id="clipitem-a2-2">[\s\S]*?<sourcetrack>\s*<mediatype>audio<\/mediatype>\s*<trackindex>2<\/trackindex>/);
  assert.equal(document.match(/<outputchannelindex>/g)?.length, 2);
  assert.equal(document.match(/<clipitem id="clipitem-a[12]-[12]">/g)?.length, 4);
  const links = document.match(/<link>[\s\S]*?<\/link>/g) ?? [];
  assert.ok(links.length > 0);
  assert.ok(links.every((link) => !/<mediatype>|<trackindex>|<clipindex>/.test(link)));
  assert.ok(links.some((link) => /<linkclipref>clipitem-a1-2<\/linkclipref>\s*<groupindex>1<\/groupindex>/.test(link)));
  assert.match(document, /<string>01:00:00;00<\/string>\s*<frame>107892<\/frame>\s*<displayformat>DF<\/displayformat>/);
  assert.match(document, /<timebase>30<\/timebase>\s*<ntsc>TRUE<\/ntsc>/);
});

test("maps every discrete source channel to its own Premiere sequence track", () => {
  const document = createPremiereXml({
    inputPath: "/tmp/surround.mov",
    clipName: "surround.mov",
    projectName: "Surround — Rough Cut",
    media: {
      duration: 4,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 25, denominator: 1 },
      audioChannels: 6,
      audioRate: 48000,
      audioLayout: "5.1",
    },
    keeps: [{ startFrame: 0, endFrame: 100 }],
  });

  assert.equal(document.match(/<outputchannelindex>/g)?.length, 6);
  assert.equal(document.match(/<clipitem id="clipitem-a\d-1">/g)?.length, 6);
  for (let channel = 1; channel <= 6; channel += 1) {
    assert.match(document, new RegExp(`<clipitem id="clipitem-a${channel}-1">[\\s\\S]*?<sourcetrack>\\s*<mediatype>audio<\\/mediatype>\\s*<trackindex>${channel}<\\/trackindex>`));
  }
  assert.doesNotMatch(document, /<groupindex>/);
});
