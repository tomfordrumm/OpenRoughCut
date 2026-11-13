const STANDARD_DIMENSIONS = new Set([
  "640x360", "640x480",
  "720x480", "720x486", "720x576",
  "960x540", "960x720",
  "1280x720", "1280x1080", "1440x1080", "1920x1080",
  "2048x1024", "2048x1080", "2048x1152", "2048x1536", "2048x1556",
  "3840x2160",
  "4096x2048", "4096x2160", "4096x2304", "4096x3112",
  "5120x2160", "5120x2560", "5120x2700",
]);

export { PROJECT_RESOLUTIONS, resolveProjectResolution } from "./project-resolution.js";

export function isStandardResolution({ width, height }) {
  return STANDARD_DIMENSIONS.has(`${width}x${height}`) || STANDARD_DIMENSIONS.has(`${height}x${width}`);
}
