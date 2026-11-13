const WORD = /[\p{L}\p{N}]+/gu;
const normalized = (text) => text.toLowerCase().replaceAll("ё", "е");
export function wordTimingBounds(segment) {
  const bounds = segment.wordTimingBounds ?? { start: segment.start, end: segment.end };
  if (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end)
    || bounds.start < Math.max(0, segment.start - .25) || bounds.start > segment.start
    || bounds.end < segment.end || bounds.end > segment.end + .25) return null;
  return { start: bounds.start, end: bounds.end };
}
export function alignWordTiming(segment, tokens, bounds = segment.wordTimingBounds) {
  const limits = wordTimingBounds({ ...segment, ...(bounds ? { wordTimingBounds: bounds } : {}) });
  if (!limits) return [];
  let text = "";
  const spans = tokens.map((token) => {
    const startChar = text.length;
    text += token.text;
    return { ...token, startChar, endChar: text.length };
  });
  const sourceWords = [...segment.text.matchAll(WORD)];
  const timedWords = [...text.matchAll(WORD)];
  if (!sourceWords.length || sourceWords.length !== timedWords.length
    || sourceWords.some((word, i) => normalized(word[0]) !== normalized(timedWords[i][0]))) return [];
  const words = [];
  for (let i = 0; i < sourceWords.length; i++) {
    const word = timedWords[i];
    const overlapping = spans.filter((token) => token.startChar < word.index + word[0].length && token.endChar > word.index);
    if (!overlapping.length || overlapping.some((t) => !Number.isFinite(t.start) || !Number.isFinite(t.end) || t.end <= t.start)) return [];
    const start = overlapping[0].start;
    const end = overlapping.at(-1).end;
    if (start < limits.start || end > limits.end || end <= start
      || (words.length && (start < words.at(-1).start || end < words.at(-1).end))) return [];
    words.push({ startChar: sourceWords[i].index, endChar: sourceWords[i].index + sourceWords[i][0].length, start, end });
  }
  return words;
}

export function timedUnitRange(unit, segment) {
  if (unit.startChar === 0 && unit.endChar === segment.text.trimEnd().length) return { start: segment.start, end: segment.end };
  const words = savedWordTiming(segment);
  const selected = words.filter((word) => word.startChar >= unit.startChar && word.endChar <= unit.endChar);
  const expected = [...segment.text.slice(unit.startChar, unit.endChar).matchAll(WORD)];
  // Never substitute the complete region for an untimed partial sentence.
  if (!selected.length || selected.length !== expected.length) return null;
  for (let i = 0; i < selected.length; i++) {
    const word = selected[i];
    if (word.startChar !== unit.startChar + expected[i].index || word.endChar !== unit.startChar + expected[i].index + expected[i][0].length
      || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) return null;
  }
  // Intersect measured times with the original speech region; never expand it.
  const start = Math.max(segment.start, selected[0].start);
  const end = Math.min(segment.end, selected.at(-1).end);
  if (end <= start) return null;
  if (words.some((word) => !selected.includes(word) && word.start < end && word.end > start)) return null;
  return { start, end };
}

// Preserve exact timestamps in saved projects; never fabricate missing timings.
export function savedWordTiming(segment) {
  const words = segment.words, bounds = wordTimingBounds(segment);
  if (!bounds || !Array.isArray(words) || words.length > 2000) return [];
  if (words.some((w, i) => !Number.isInteger(w.startChar) || !Number.isInteger(w.endChar)
    || w.startChar < 0 || w.endChar <= w.startChar || w.endChar > segment.text.length
    || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < bounds.start || w.end > bounds.end || w.end <= w.start
    || (i && (w.startChar < words[i - 1].endChar || w.start < words[i - 1].start || w.end < words[i - 1].end)))) return [];
  return words.map(({ startChar, endChar, start, end }) => ({ startChar, endChar, start, end }));
}
