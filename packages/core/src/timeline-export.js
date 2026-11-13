import { createFcpxml } from "./fcpxml.js";
import { createOtio } from "./otio.js";
import { createPremiereXml } from "./premiere-xml.js";

export const TIMELINE_EXPORTS = {
  "final-cut": {
    label: "Final Cut Pro",
    shortLabel: "FCPXML",
    extension: "fcpxml",
    filterName: "Final Cut Pro XML",
    createDocument: createFcpxml,
  },
  premiere: {
    label: "Premiere Pro",
    shortLabel: "Premiere XML",
    extension: "xml",
    filterName: "Premiere Pro XML",
    createDocument: createPremiereXml,
  },
  resolve: {
    label: "DaVinci Resolve",
    shortLabel: "Resolve OTIO",
    extension: "otio",
    filterName: "OpenTimelineIO",
    createDocument: createOtio,
  },
  // Not a timeline: the cut is rendered straight to a video file.
  mp4: {
    label: "Video (MP4)",
    shortLabel: "MP4",
    extension: "mp4",
    filterName: "MPEG-4 video",
    renders: true,
  },
};

export function timelineExportFor(format = "final-cut") {
  const target = TIMELINE_EXPORTS[format];
  if (!target) throw new Error("Unsupported timeline export format.");
  return target;
}

export function createTimelineDocument(format, options) {
  const target = timelineExportFor(format);
  if (target.renders) throw new Error(`${target.label} is rendered, not written as a timeline document.`);
  return target.createDocument(options);
}
