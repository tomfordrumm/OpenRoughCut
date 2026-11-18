import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { isStandardResolution, resolveProjectResolution } from "@openroughcut/core/resolution.js";

// Asks in a terminal only when the source size is unusual and no choice was given.
export async function chooseProjectResolution(media, requestedChoice, { signal } = {}) {
  signal?.throwIfAborted();
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
      const answer = (await readline.question("Selection [1]: ", { signal })).trim() || "1";
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
