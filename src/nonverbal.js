const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const NON_VERBAL_ANNOTATION = /^\s*[[(<].+[\])>]\s*$/u;
const FILLER_SOUND = /^(?:[\u043C\u044D\u044B]+|\u044D+\u043C+|[\u0430\u0443]{2,}|h+m+|m{1,}|u+h+|u+m+)$/iu;

export const NON_VERBAL_SILENCE_SECONDS = 0.18;

function stableSeconds(value) {
  return Number(value.toFixed(6));
}

function normalizeSilences(silences, duration) {
  const normalized = (silences ?? [])
    .map((item) => ({
      start: Math.max(0, Math.min(duration, Number(item?.start))),
      end: Math.max(0, Math.min(duration, Number(item?.end))),
    }))
    .filter((item) => Number.isFinite(item.start)
      && Number.isFinite(item.end)
      && item.end > item.start)
    .sort((first, second) => first.start - second.start || first.end - second.end);
  const merged = [];
  for (const item of normalized) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

export function nonVerbalSilenceSettings(settings) {
  return {
    thresholdDb: Number(settings?.thresholdDb),
    minimumSilence: Math.min(Number(settings?.minimumSilence), NON_VERBAL_SILENCE_SECONDS),
  };
}

export function buildSoundIslands(silences, durationSeconds, {
  minimumSoundSeconds = 0.02,
  maximumSoundSeconds = 3,
} = {}) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const quiet = normalizeSilences(silences, duration);
  const islands = [];
  let cursor = 0;
  let previousSilence = null;

  const addIsland = (start, end, nextSilence) => {
    const soundDuration = end - start;
    if (soundDuration < minimumSoundSeconds || soundDuration > maximumSoundSeconds) return;
    islands.push({
      soundStart: stableSeconds(start),
      soundEnd: stableSeconds(end),
      start: stableSeconds(previousSilence?.start ?? start),
      end: stableSeconds(nextSilence?.end ?? end),
    });
  };

  for (const silence of quiet) {
    addIsland(cursor, silence.start, silence);
    cursor = Math.max(cursor, silence.end);
    previousSilence = silence;
  }
  addIsland(cursor, duration, null);
  return islands;
}

function overlaps(item, start, end) {
  return item.end >= start && item.start <= end;
}

function normalizedSoundText(value) {
  return String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

export function isFillerSound(value) {
  const normalized = normalizedSoundText(value);
  return Boolean(normalized && FILLER_SOUND.test(normalized));
}

function candidate(island, confidence, removedText, applied) {
  return {
    reason: "non-verbal",
    start: island.start,
    end: island.end,
    soundStart: island.soundStart,
    soundEnd: island.soundEnd,
    confidence,
    similarity: 0,
    removedText,
    keptText: "",
    applied,
  };
}

export function detectNonVerbalSounds(soundIslands, {
  tokens = [],
  utterances = [],
  wordGuardSeconds = 0.12,
  lowConfidenceThreshold = 0.25,
} = {}) {
  const candidates = [];

  for (const island of soundIslands ?? []) {
    const nearbyTokens = tokens.filter((item) => WORD_CHARACTER.test(String(item?.text ?? ""))
      && overlaps(item, island.soundStart - wordGuardSeconds, island.soundEnd + wordGuardSeconds));
    const nearbyUtterances = utterances.filter((item) => overlaps(item, island.soundStart, island.soundEnd));
    const recognizedText = nearbyTokens.map((item) => String(item.text).trim()).filter(Boolean).join("").trim();
    const annotationText = nearbyUtterances
      .map((item) => String(item.text ?? "").trim())
      .filter((text) => NON_VERBAL_ANNOTATION.test(text));

    if (!nearbyTokens.length) {
      candidates.push(candidate(island, 0.99, "No spoken words detected", true));
      continue;
    }
    if (isFillerSound(recognizedText) || annotationText.length === nearbyUtterances.length && annotationText.length > 0) {
      candidates.push(candidate(island, 0.97, recognizedText || annotationText.join(" "), true));
      continue;
    }

    const strongestWord = Math.max(...nearbyTokens.map((item) => Number(item?.probability) || 0));
    if (strongestWord < lowConfidenceThreshold) {
      candidates.push(candidate(island, 0.72, recognizedText || "Possible non-word sound", false));
    }
  }

  return {
    candidates,
    applied: candidates.filter((item) => item.applied),
  };
}
