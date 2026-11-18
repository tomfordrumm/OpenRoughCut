export const PROJECT_RESOLUTIONS = {
  source: null,
  "4k": { width: 3840, height: 2160, label: "UHD 4K" },
  "full-hd": { width: 1920, height: 1080, label: "Full HD" },
  "vertical-4k": { width: 2160, height: 3840, label: "Vertical UHD 4K" },
  "vertical-full-hd": { width: 1080, height: 1920, label: "Vertical Full HD" },
};

export function resolveProjectResolution(media, choice) {
  if (!Object.hasOwn(PROJECT_RESOLUTIONS, choice)) {
    throw new Error("--project-resolution must be source, 4k, full-hd, vertical-4k, or vertical-full-hd.");
  }
  const resolution = PROJECT_RESOLUTIONS[choice];
  return resolution
    ? { width: resolution.width, height: resolution.height, choice }
    : { width: media.width, height: media.height, choice: "source" };
}
