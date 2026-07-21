import { pathToFileURL } from "node:url";

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}

export function frameTime(frames, frameRate) {
  if (frames === 0) return "0s";
  const numerator = frames * frameRate.denominator;
  const divisor = gcd(numerator, frameRate.numerator);
  const reducedNumerator = numerator / divisor;
  const reducedDenominator = frameRate.numerator / divisor;
  return reducedDenominator === 1 ? `${reducedNumerator}s` : `${reducedNumerator}/${reducedDenominator}s`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function frameRateSuffix(frameRate) {
  const key = `${frameRate.numerator}/${frameRate.denominator}`;
  return {
    "24000/1001": "2398",
    "24/1": "24",
    "25/1": "25",
    "30000/1001": "2997",
    "30/1": "30",
    "50/1": "50",
    "60000/1001": "5994",
    "60/1": "60",
  }[key];
}

export function predefinedFormatName({ width, height }, frameRate) {
  const suffix = frameRateSuffix(frameRate);
  if (!suffix) return null;
  if (width === 1920 && height === 1080) return `FFVideoFormat1080p${suffix}`;
  if (width === 1280 && height === 720) return `FFVideoFormat720p${suffix}`;
  if (width === 3840 && height === 2160) return `FFVideoFormat3840x2160p${suffix}`;
  if (width === 4096 && height === 2160) return `FFVideoFormat4096x2160p${suffix}`;
  return null;
}

function formatResource(id, resolution, frameRate) {
  const name = predefinedFormatName(resolution, frameRate);
  if (name) return `<format id="${id}" name="${name}"/>`;
  return `<format id="${id}" frameDuration="${frameTime(1, frameRate)}" width="${resolution.width}" height="${resolution.height}"/>`;
}

export function createFcpxml({ inputPath, clipName, compoundName, projectName, media, projectResolution = media, keeps }) {
  const { frameRate } = media;
  const resolvedCompoundName = compoundName ?? `${clipName} — Source`;
  const sourceDurationFrames = Math.round(media.duration * frameRate.numerator / frameRate.denominator);
  const timelineDurationFrames = keeps.reduce((total, item) => total + item.endFrame - item.startFrame, 0);
  let timelineOffset = 0;

  const clips = keeps.map((item) => {
    const duration = item.endFrame - item.startFrame;
    const result = `          <ref-clip name="${xml(resolvedCompoundName)}" ref="r4" offset="${frameTime(timelineOffset, frameRate)}" start="${frameTime(item.startFrame, frameRate)}" duration="${frameTime(duration, frameRate)}"/>`;
    timelineOffset += duration;
    return result;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    ${formatResource("r1", media, frameRate)}
    ${formatResource("r3", projectResolution, frameRate)}
    <asset id="r2" name="${xml(clipName)}" start="0s" duration="${frameTime(sourceDurationFrames, frameRate)}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="${media.audioChannels}" audioRate="${media.audioRate}">
      <media-rep kind="original-media" src="${xml(pathToFileURL(inputPath).href)}"/>
    </asset>
    <media id="r4" name="${xml(resolvedCompoundName)}">
      <sequence format="r3" duration="${frameTime(sourceDurationFrames, frameRate)}" tcStart="0s" tcFormat="NDF">
        <spine>
          <asset-clip name="${xml(clipName)}" ref="r2" offset="0s" start="0s" duration="${frameTime(sourceDurationFrames, frameRate)}" audioRole="dialogue"/>
        </spine>
      </sequence>
    </media>
  </resources>
  <event name="OpenRoughCut">
    <ref-clip name="${xml(resolvedCompoundName)}" ref="r4" start="0s" duration="${frameTime(sourceDurationFrames, frameRate)}"/>
    <project name="${xml(projectName)}">
      <sequence format="r3" duration="${frameTime(timelineDurationFrames, frameRate)}" tcStart="0s" tcFormat="NDF">
        <spine>
${clips}
        </spine>
      </sequence>
    </project>
  </event>
</fcpxml>
`;
}
