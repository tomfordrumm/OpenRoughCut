import { pathToFileURL } from "node:url";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function premiereRate(frameRate) {
  const { numerator, denominator } = frameRate;
  if (denominator === 1 && Number.isInteger(numerator)) {
    return { timebase: numerator, ntsc: false };
  }
  if (denominator === 1001 && numerator % 1000 === 0) {
    return { timebase: numerator / 1000, ntsc: true };
  }
  throw new Error("Premiere XML supports integer and 1000/1001 video frame rates only.");
}

function rateXml(frameRate, indentation) {
  const { timebase, ntsc } = premiereRate(frameRate);
  return `${indentation}<rate>\n${indentation}  <timebase>${timebase}</timebase>\n${indentation}  <ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc>\n${indentation}</rate>`;
}

function videoCharacteristics(resolution, frameRate, indentation) {
  return `${indentation}<samplecharacteristics>\n${rateXml(frameRate, `${indentation}  `)}\n${indentation}  <width>${resolution.width}</width>\n${indentation}  <height>${resolution.height}</height>\n${indentation}  <anamorphic>FALSE</anamorphic>\n${indentation}  <pixelaspectratio>square</pixelaspectratio>\n${indentation}  <fielddominance>none</fielddominance>\n${indentation}</samplecharacteristics>`;
}

function linkXml(videoId, audioIds, stereo, indentation) {
  const linkedItems = [
    { id: videoId, groupIndex: null },
    ...audioIds.map((id) => ({ id, groupIndex: stereo ? 1 : null })),
  ];
  return linkedItems.map((item) => `${indentation}<link>\n${indentation}  <linkclipref>${item.id}</linkclipref>${item.groupIndex ? `\n${indentation}  <groupindex>${item.groupIndex}</groupindex>` : ""}\n${indentation}</link>`).join("\n");
}

function clipItem({ id, linkedVideoId, linkedAudioIds, stereo, clipName, sourceDurationFrames, frameRate, startFrame, endFrame, timelineStart, mediaType, sourceTrackIndex }) {
  const timelineEnd = timelineStart + endFrame - startFrame;
  const sourceTrack = mediaType === "video"
    ? `              <sourcetrack>\n                <mediatype>video</mediatype>\n              </sourcetrack>`
    : `              <sourcetrack>\n                <mediatype>audio</mediatype>\n                <trackindex>${sourceTrackIndex}</trackindex>\n              </sourcetrack>`;
  return `            <clipitem id="${id}">
              <name>${xml(clipName)}</name>
              <duration>${sourceDurationFrames}</duration>
${rateXml(frameRate, "              ")}
              <start>${timelineStart}</start>
              <end>${timelineEnd}</end>
              <in>${startFrame}</in>
              <out>${endFrame}</out>
              <masterclipid>masterclip-1</masterclipid>
              <file id="file-1"/>
${sourceTrack}
${linkXml(linkedVideoId, linkedAudioIds, stereo, "              ")}
            </clipitem>`;
}

export function createPremiereXml({ inputPath, clipName, projectName, media, projectResolution = media, keeps }) {
  premiereRate(media.frameRate);
  const sourceDurationFrames = Math.round(media.duration * media.frameRate.numerator / media.frameRate.denominator);
  const timelineDurationFrames = keeps.reduce((total, item) => total + item.endFrame - item.startFrame, 0);
  let timelineStart = 0;
  const videoItems = [];
  const audioItemsByChannel = Array.from({ length: media.audioChannels }, () => []);
  const stereo = media.audioChannels === 2 && (media.audioLayout ?? "stereo") === "stereo";
  const outputChannels = Array.from({ length: media.audioChannels }, (_, index) => `                <channel>\n                  <index>${index + 1}</index>\n                </channel>`).join("\n");
  const sourceAudioChannels = Array.from({ length: media.audioChannels }, (_, index) => `              <audiochannel>\n                <channellabel>${stereo ? index === 0 ? "left" : "right" : "discrete"}</channellabel>\n                <sourcechannel>${index + 1}</sourcechannel>\n              </audiochannel>`).join("\n");
  const sourceLayout = stereo ? "              <layout>stereo</layout>\n" : media.audioChannels === 1 ? "              <layout>mono</layout>\n" : "";
  const sourceStartFrame = Number.isFinite(media.sourceStartFrame) ? Math.round(media.sourceStartFrame) : 0;
  const sourceTimecode = media.sourceTimecode ?? "00:00:00:00";
  const sourceTimecodeDisplayFormat = media.sourceTimecodeDisplayFormat === "DF" ? "DF" : "NDF";

  keeps.forEach((item, index) => {
    const clipIndex = index + 1;
    const videoId = `clipitem-v-${clipIndex}`;
    const audioIds = Array.from({ length: media.audioChannels }, (_, channelIndex) => `clipitem-a${channelIndex + 1}-${clipIndex}`);
    const values = {
      linkedVideoId: videoId,
      linkedAudioIds: audioIds,
      stereo,
      clipName,
      sourceDurationFrames,
      frameRate: media.frameRate,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      timelineStart,
    };
    videoItems.push(clipItem({ ...values, id: videoId, mediaType: "video" }));
    audioIds.forEach((audioId, channelIndex) => {
      audioItemsByChannel[channelIndex].push(clipItem({ ...values, id: audioId, mediaType: "audio", sourceTrackIndex: channelIndex + 1 }));
    });
    timelineStart += item.endFrame - item.startFrame;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <project>
    <name>OpenRoughCut</name>
    <children>
      <clip id="masterclip-1">
        <name>${xml(clipName)}</name>
        <duration>${sourceDurationFrames}</duration>
${rateXml(media.frameRate, "        ")}
        <masterclipid>masterclip-1</masterclipid>
        <ismasterclip>TRUE</ismasterclip>
        <file id="file-1">
          <name>${xml(clipName)}</name>
          <pathurl>${xml(pathToFileURL(inputPath).href)}</pathurl>
${rateXml(media.frameRate, "          ")}
          <duration>${sourceDurationFrames}</duration>
          <timecode>
${rateXml(media.frameRate, "            ")}
            <string>${xml(sourceTimecode)}</string>
            <frame>${sourceStartFrame}</frame>
            <displayformat>${sourceTimecodeDisplayFormat}</displayformat>
          </timecode>
          <media>
            <video>
${videoCharacteristics(media, media.frameRate, "              ")}
            </video>
            <audio>
              <samplecharacteristics>
                <depth>16</depth>
                <samplerate>${media.audioRate}</samplerate>
              </samplecharacteristics>
              <channelcount>${media.audioChannels}</channelcount>
${sourceLayout}${sourceAudioChannels}
            </audio>
          </media>
        </file>
      </clip>
      <sequence id="sequence-1">
        <name>${xml(projectName)}</name>
        <duration>${timelineDurationFrames}</duration>
${rateXml(media.frameRate, "        ")}
        <timecode>
${rateXml(media.frameRate, "          ")}
          <string>00:00:00:00</string>
          <frame>0</frame>
          <displayformat>NDF</displayformat>
        </timecode>
        <media>
          <video>
            <format>
${videoCharacteristics(projectResolution, media.frameRate, "              ")}
            </format>
            <track>
${videoItems.join("\n")}
              <enabled>TRUE</enabled>
              <locked>FALSE</locked>
            </track>
          </video>
          <audio>
            <format>
              <samplecharacteristics>
                <depth>16</depth>
                <samplerate>${media.audioRate}</samplerate>
              </samplecharacteristics>
            </format>
            <outputs>
              <group>
                <index>1</index>
                <numchannels>${media.audioChannels}</numchannels>
                <downmix>0</downmix>
${outputChannels}
              </group>
            </outputs>
${audioItemsByChannel.map((items, channelIndex) => `            <track>\n${items.join("\n")}\n              <enabled>TRUE</enabled>\n              <locked>FALSE</locked>\n              <outputchannelindex>${channelIndex + 1}</outputchannelindex>\n            </track>`).join("\n")}
          </audio>
        </media>
      </sequence>
    </children>
  </project>
</xmeml>
`;
}
