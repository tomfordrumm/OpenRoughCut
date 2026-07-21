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
};

export function timelineExportFor(format = "final-cut") {
  const target = TIMELINE_EXPORTS[format];
  if (!target) throw new Error("Unsupported timeline export format.");
  return target;
}

export function createTimelineDocument(format, options) {
  return timelineExportFor(format).createDocument(options);
}
