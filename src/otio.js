import { pathToFileURL } from "node:url";

function rationalTime(value, rate) {
  return { OTIO_SCHEMA: "RationalTime.1", rate, value };
}

function timeRange(startFrame, durationFrames, rate) {
  return {
    OTIO_SCHEMA: "TimeRange.1",
    duration: rationalTime(durationFrames, rate),
    start_time: rationalTime(startFrame, rate),
  };
}

function mediaReference(inputPath, clipName, sourceStartFrame, sourceDurationFrames, rate) {
  return {
    OTIO_SCHEMA: "ExternalReference.1",
    available_range: timeRange(sourceStartFrame, sourceDurationFrames, rate),
    metadata: {},
    target_url: pathToFileURL(inputPath).href,
    name: clipName,
  };
}

function track(kind, clipName, inputPath, sourceStartFrame, sourceDurationFrames, rate, keeps) {
  return {
    OTIO_SCHEMA: "Track.1",
    children: keeps.map((item, index) => ({
      OTIO_SCHEMA: "Clip.1",
      effects: [],
      markers: [],
      enabled: true,
      media_reference: mediaReference(inputPath, clipName, sourceStartFrame, sourceDurationFrames, rate),
      metadata: { roughcut: { retained_range: index + 1 } },
      name: `${clipName} · ${index + 1}`,
      source_range: timeRange(sourceStartFrame + item.startFrame, item.endFrame - item.startFrame, rate),
    })),
    effects: [],
    kind,
    markers: [],
    enabled: true,
    metadata: {},
    name: kind === "Video" ? "V1 · Rough Cut" : "A1 · Dialogue",
    source_range: null,
  };
}

export function createOtio({ inputPath, clipName, projectName, media, projectResolution = media, keeps }) {
  const rate = media.frameRate.numerator / media.frameRate.denominator;
  const sourceDurationFrames = Math.round(media.duration * rate);
  const sourceStartFrame = Number.isFinite(media.sourceStartFrame) ? Math.round(media.sourceStartFrame) : 0;
  const document = {
    OTIO_SCHEMA: "Timeline.1",
    metadata: {
      roughcut: {
        source_width: media.width,
        source_height: media.height,
        timeline_width: projectResolution.width,
        timeline_height: projectResolution.height,
        frame_rate_numerator: media.frameRate.numerator,
        frame_rate_denominator: media.frameRate.denominator,
        source_timecode: media.sourceTimecode ?? "00:00:00:00",
        resolution_application: "Set the timeline resolution in DaVinci Resolve after importing this OTIO file.",
      },
    },
    name: projectName,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      children: [
        track("Video", clipName, inputPath, sourceStartFrame, sourceDurationFrames, rate, keeps),
        track("Audio", clipName, inputPath, sourceStartFrame, sourceDurationFrames, rate, keeps),
      ],
      effects: [],
      markers: [],
      enabled: true,
      metadata: {},
      name: "tracks",
      source_range: null,
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
