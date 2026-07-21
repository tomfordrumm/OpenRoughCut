import test from "node:test";
import assert from "node:assert/strict";
import { createOtio } from "../src/otio.js";

test("creates Resolve-compatible OTIO video and audio tracks from retained ranges", () => {
  const parsed = JSON.parse(createOtio({
    inputPath: "/tmp/A & B.mov",
    clipName: "A & B.mov",
    projectName: "A & B — Rough Cut",
    media: {
      duration: 10,
      width: 1920,
      height: 1080,
      frameRate: { numerator: 25, denominator: 1 },
      audioChannels: 2,
      audioRate: 48000,
      sourceTimecode: "01:00:00:00",
      sourceStartFrame: 90_000,
    },
    projectResolution: { width: 3840, height: 2160 },
    keeps: [
      { startFrame: 0, endFrame: 50 },
      { startFrame: 100, endFrame: 250 },
    ],
  }));

  assert.equal(parsed.OTIO_SCHEMA, "Timeline.1");
  assert.equal(parsed.name, "A & B — Rough Cut");
  assert.deepEqual(parsed.metadata.roughcut, {
    source_width: 1920,
    source_height: 1080,
    timeline_width: 3840,
    timeline_height: 2160,
    frame_rate_numerator: 25,
    frame_rate_denominator: 1,
    source_timecode: "01:00:00:00",
    resolution_application: "Set the timeline resolution in DaVinci Resolve after importing this OTIO file.",
  });
  assert.deepEqual(parsed.tracks.children.map((item) => item.kind), ["Video", "Audio"]);
  for (const track of parsed.tracks.children) {
    assert.equal(track.children.length, 2);
    assert.equal(track.children[0].media_reference.target_url, "file:///tmp/A%20&%20B.mov");
    assert.deepEqual(track.children[0].media_reference.available_range.start_time, { OTIO_SCHEMA: "RationalTime.1", rate: 25, value: 90_000 });
    assert.deepEqual(track.children[0].source_range.start_time, { OTIO_SCHEMA: "RationalTime.1", rate: 25, value: 90_000 });
    assert.deepEqual(track.children[0].source_range.duration, { OTIO_SCHEMA: "RationalTime.1", rate: 25, value: 50 });
    assert.equal(track.children[1].source_range.start_time.value, 90_100);
    assert.equal(track.children[1].source_range.duration.value, 150);
  }
});
