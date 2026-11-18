const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const NON_VERBAL_ANNOTATION = /^\s*(?:[[(<].+[\])>]|\*[^*]+\*)\s*$/u;
const FILLER_SOUND = /^(?:[\u043C\u044D\u044B]+|\u044D+\u043C+|[\u0430\u0443]{2,}|\u0431+\u0440+|\u043F\u0430\u0445|h+m+|m{1,}|u+h+|u+m+|b+r+)$/iu;

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
  maximumSoundSeconds = Number.POSITIVE_INFINITY,
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
  removedSpeech = [],
} = {}) {
  const candidates = [];
  const removedRanges = [...removedSpeech].sort((a, b) => a.start - b.start);
  const fullyRemoved = island => {
    let cursor = island.soundStart;
    for (const range of removedRanges) {
      if (range.start > cursor) break;
      cursor = Math.max(cursor, range.end);
      if (cursor >= island.soundEnd) return true;
    }
    return false;
  };
  const removed = item => removedSpeech.some(r => r.start <= item.start && r.end >= item.end);
  tokens = tokens.filter(t => !removed(t));
  utterances = utterances.filter(u => !removed(u));

  for (const island of soundIslands ?? []) {
    if (fullyRemoved(island)) continue;
    const nearbyTokens = tokens.filter((item) => WORD_CHARACTER.test(String(item?.text ?? ""))
      && overlaps(item, island.soundStart - wordGuardSeconds, island.soundEnd + wordGuardSeconds));
    const soundTokens = nearbyTokens.filter((item) => overlaps(item, island.soundStart, island.soundEnd));
    const nearbyUtterances = utterances.filter((item) => overlaps(item, island.soundStart, island.soundEnd));
    const recognizedText = nearbyTokens.map((item) => String(item.text).trim()).filter(Boolean).join("").trim();
    const soundText = soundTokens.map((item) => String(item.text).trim()).filter(Boolean).join("").trim();
    const annotationText = nearbyUtterances
      .map((item) => String(item.text ?? "").trim())
      .filter((text) => NON_VERBAL_ANNOTATION.test(text));

    // Missing token alignment must not turn a real short utterance into silence.
    const lexicalUtterances = nearbyUtterances.filter(u => WORD_CHARACTER.test(u.text) && !NON_VERBAL_ANNOTATION.test(u.text) && !isFillerSound(u.text));
    if (!soundTokens.length && lexicalUtterances.length) continue;

    const protectWords = proposed => {
      const protectedTokens = tokens.filter(t => WORD_CHARACTER.test(String(t.text ?? '')) && overlaps(t, island.start, island.end) && !isFillerSound(t.text)
        && !(annotationText.length && !lexicalUtterances.length && overlaps(t, island.soundStart, island.soundEnd)));
      let start = proposed.start, end = proposed.end;
      for (const token of protectedTokens) {
        if (token.end <= island.soundStart) start = Math.max(start, token.end + 0.04);
        else if (token.start >= island.soundEnd) end = Math.min(end, token.start - 0.04);
        else return null;
      }
      return end > start && start <= island.soundStart && end >= island.soundEnd ? { ...proposed, start: stableSeconds(start), end: stableSeconds(end) } : null;
    };

    if (!soundTokens.length && !lexicalUtterances.length) {
      const proposed = protectWords(candidate(island, 0.99, "No spoken words detected", true));
      if (proposed) candidates.push(proposed);
      continue;
    }
    if (isFillerSound(soundText)
      || isFillerSound(recognizedText)
      || annotationText.length === nearbyUtterances.length && annotationText.length > 0) {
      const proposed = protectWords(candidate(island, 0.97, soundText || recognizedText || annotationText.join(" "), true));
      if (proposed) candidates.push(proposed);
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
