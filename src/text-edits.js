const TERMINAL_PUNCTUATION = /[.!?。！？]$/u;
const INCOMPLETE_ENDING = /(?:\.{2,}|…|[-—–])$/u;

export function normalizeWords(text) {
  return String(text)
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) ?? [];
}

function longestCommonPrefix(first, second) {
  let length = 0;
  while (length < first.length && length < second.length && first[length] === second[length]) length += 1;
  return length;
}

function longestCommonSubsequence(first, second) {
  const previous = new Array(second.length + 1).fill(0);
  for (const left of first) {
    let diagonal = 0;
    for (let index = 1; index <= second.length; index += 1) {
      const saved = previous[index];
      previous[index] = left === second[index - 1]
        ? diagonal + 1
        : Math.max(previous[index], previous[index - 1]);
      diagonal = saved;
    }
  }
  return previous[second.length];
}

function diceSimilarity(first, second) {
  const firstSet = new Set(first);
  const secondSet = new Set(second);
  let overlap = 0;
  for (const word of firstSet) if (secondSet.has(word)) overlap += 1;
  return (2 * overlap) / (firstSet.size + secondSet.size || 1);
}

export function phraseSimilarity(first, second) {
  const firstWords = Array.isArray(first) ? first : normalizeWords(first);
  const secondWords = Array.isArray(second) ? second : normalizeWords(second);
  if (!firstWords.length || !secondWords.length) return 0;
  const sequence = longestCommonSubsequence(firstWords, secondWords) / Math.max(firstWords.length, secondWords.length);
  const vocabulary = diceSimilarity(firstWords, secondWords);
  return Math.max(sequence, (sequence * 0.65) + (vocabulary * 0.35));
}

function candidate(reason, earlier, later, confidence, similarity) {
  return {
    reason,
    start: earlier.start,
    end: later.start,
    confidence: Math.min(0.99, Number(confidence.toFixed(3))),
    similarity: Number(similarity.toFixed(3)),
    removedText: earlier.text,
    keptText: later.text,
  };
}

export function detectTextEdits(segments, {
  maxGapSeconds = 15,
  autoConfidence = 0.9,
} = {}) {
  const prepared = segments.map((segment) => ({ ...segment, words: normalizeWords(segment.text) }));
  const candidates = [];

  for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
    const earlier = prepared[leftIndex];
    if (earlier.words.length < 3) continue;
    let bestCandidate = null;

    for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
      const later = prepared[rightIndex];
      const retrySpan = later.start - earlier.start;
      const gap = later.start - earlier.end;
      if (retrySpan > maxGapSeconds) break;
      if (gap < 0 || later.words.length < 3) continue;

      const prefixLength = longestCommonPrefix(earlier.words, later.words);
      const prefixRatio = prefixLength / Math.min(earlier.words.length, later.words.length);
      const similarity = phraseSimilarity(earlier.words, later.words);
      const lengthRatio = later.words.length / earlier.words.length;
      const requiredPrefix = Math.min(3, earlier.words.length);
      const visiblyIncomplete = INCOMPLETE_ENDING.test(earlier.text.trim())
        || !TERMINAL_PUNCTUATION.test(earlier.text.trim());

      if (prefixLength >= requiredPrefix
        && later.words.length > earlier.words.length
        && (visiblyIncomplete || lengthRatio >= 1.6)) {
        const confidence = 0.82
          + (0.1 * prefixRatio)
          + (0.07 * Math.min(1, (lengthRatio - 1) / 1.5));
        const found = candidate("false-start", earlier, later, confidence, similarity);
        if (!bestCandidate || found.confidence > bestCandidate.confidence) bestCandidate = found;
        continue;
      }

      if (Math.min(earlier.words.length, later.words.length) >= 4
        && lengthRatio >= 0.65
        && lengthRatio <= 1.55
        && similarity >= 0.68) {
        const exactSequence = similarity >= 0.98;
        const confidence = exactSequence ? 0.98 : Math.min(0.89, 0.65 + (0.25 * similarity));
        const found = candidate("repeated-take", earlier, later, confidence, similarity);
        if (!bestCandidate || found.confidence > bestCandidate.confidence) bestCandidate = found;
      }
    }
    if (bestCandidate) candidates.push(bestCandidate);
  }

  candidates.sort((first, second) => first.start - second.start || second.confidence - first.confidence);
  return {
    candidates,
    applied: candidates.filter((item) => item.confidence >= autoConfidence),
  };
}
