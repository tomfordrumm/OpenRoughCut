import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

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

export const PROJECT_RESOLUTIONS = {
  source: null,
  "4k": { width: 3840, height: 2160, label: "UHD 4K" },
  "full-hd": { width: 1920, height: 1080, label: "Full HD" },
  "vertical-4k": { width: 2160, height: 3840, label: "Vertical UHD 4K" },
  "vertical-full-hd": { width: 1080, height: 1920, label: "Vertical Full HD" },
};

export function isStandardResolution({ width, height }) {
  return STANDARD_DIMENSIONS.has(`${width}x${height}`) || STANDARD_DIMENSIONS.has(`${height}x${width}`);
}

export function resolveProjectResolution(media, choice) {
  if (!Object.hasOwn(PROJECT_RESOLUTIONS, choice)) {
    throw new Error("--project-resolution must be source, 4k, full-hd, vertical-4k, or vertical-full-hd.");
  }
  const resolution = PROJECT_RESOLUTIONS[choice];
  return resolution
    ? { width: resolution.width, height: resolution.height, choice }
    : { width: media.width, height: media.height, choice: "source" };
}

export async function chooseProjectResolution(media, requestedChoice) {
  if (requestedChoice) return resolveProjectResolution(media, requestedChoice);
  if (isStandardResolution(media)) return resolveProjectResolution(media, "source");

  console.log(`\nNon-standard source resolution detected: ${media.width}x${media.height}`);
  console.log("Choose the Final Cut project resolution:");
  console.log(`  1) Source (${media.width}x${media.height})`);
  console.log("  2) UHD 4K (3840x2160)");
  console.log("  3) Full HD (1920x1080)");
  console.log("  4) Vertical UHD 4K (2160x3840)");
  console.log("  5) Vertical Full HD (1080x1920)");

  if (!stdin.isTTY || !stdout.isTTY) {
    console.log("No interactive terminal detected; using the source resolution.\n");
    return resolveProjectResolution(media, "source");
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const answer = (await readline.question("Selection [1]: ")).trim() || "1";
      if (answer === "1") return resolveProjectResolution(media, "source");
      if (answer === "2") return resolveProjectResolution(media, "4k");
      if (answer === "3") return resolveProjectResolution(media, "full-hd");
      if (answer === "4") return resolveProjectResolution(media, "vertical-4k");
      if (answer === "5") return resolveProjectResolution(media, "vertical-full-hd");
      console.log("Please enter a number from 1 to 5.");
    }
  } finally {
    readline.close();
  }
}
