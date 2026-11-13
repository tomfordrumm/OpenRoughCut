// "Last take wins" duplicate detection.
//
// An editor cutting a talking-head recording follows one rule: when the speaker
// starts a line again, everything from the start of the first attempt up to the
// start of the final attempt goes, including any muttering in between. This
// module implements that rule directly instead of trying to prove that each
// removed attempt is semantically covered by the kept one.
//
//  1. Speech is split into units: transcript segments, further split where the
//     speaker restarts the segment's own opening mid-segment (needs word timing).
//  2. A unit restarts an earlier nearby unit when both begin the same way.
//  3. Each restart link removes [start of earlier unit, end of the unit just
//     before the restart]. Chained links therefore remove every attempt except
//     the last one.
//  4. Each cut gets a confidence. Links with substantial unrelated speech in
//     between, or whose final attempt itself looks broken, stay suggestions.
import { savedWordTiming } from "./word-timing.js";

export const LAST_TAKE_MODE = "last-take";
export const LAST_TAKE_POLICY = "last-take-v1";

const DEFAULTS = {
  autoConfidence: 0.9,
  maxLookbackSeconds: 60,
  maxLookbackUnits: 8,
  // Words in non-attempt units between two attempts before the link stops
  // looking like a retake and starts looking like a repeated sentence pattern.
  maxInterveningWords: 10,
};

// Words that open many different sentences and therefore say nothing about
// which line of the script is being recorded.
const FUNCTION_WORDS = new Set(`
  и а но ну вот так то это ведь же да нет или либо
  в во на с со к ко по о об обо от до из за для при про у над под без через
  что чтобы как который которая которое которые которых если когда где там тут здесь
  уже еще ещё тоже также очень просто даже бы ли же вроде типа
  этот эта это эти этом этого этой этих тот та те того том
  я ты мы вы он она оно они меня мне нас нам вас вам его её ее их ему ей им
  был была было были быть есть будет не ни
  например условно получается поэтому потому значит кстати собственно честно
`.split(/\s+/).filter(Boolean));

const RECORDING_COMMAND = /(?:^|[^\p{L}])(?:погнали|заново|сначала|стоп|дубль|ещ[её]\s+раз|давай\s+ещ[её])(?=$|[^\p{L}])/iu;
const SOFT_COMMAND = /^[\s\p{P}]*(?:\p{L}+[\s\p{P}]+)?(?:сейчас|блин|так)[\s\p{P}]*$/iu;
const PROFANITY = /(?:^|[^\p{L}])(?:бля\p{L}*|хуй\p{L}*|нахуй|пизд\p{L}*|еба\p{L}*|ёба\p{L}*)/iu;
const UNFINISHED = /(?:\.{2,}|…|[-—–])\s*$/u;
// Whisper's own sound annotations: "*Кхм*", "[музыка]", "(смех)".
const SOUND_ANNOTATION = /^[\s\p{P}]*(?:\*[^*]*\*|\[[^\]]*\]|\([^)]*\))[\s\p{P}]*$/u;

const normalize = (word) => word.toLowerCase().replaceAll("ё", "е");
// A crude prefix stem is enough to match inflections of the same word
// ("результаты" / "результат") without a morphology dictionary.
const stem = (word) => (word.length > 5 ? word.slice(0, 5) : word);

function tokenize(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => {
    const word = normalize(match[0]);
    return { word, stem: stem(word), startChar: match.index, endChar: match.index + match[0].length, content: !FUNCTION_WORDS.has(word) };
  });
}

const contentStems = (tokens, limit) => tokens.filter((t) => t.content).slice(0, limit).map((t) => t.stem);
// Leading "и", "ну", "вот" often change between attempts of the same line.
const LEADING_FILLERS = new Set(["и", "а", "но", "ну", "вот", "так"]);
const withoutLeadingFillers = (tokens) => { let i = 0; while (i < tokens.length - 1 && i < 2 && LEADING_FILLERS.has(tokens[i].word)) i++; return tokens.slice(i); };

// Character offsets where the segment's own opening is spoken again.
function internalRestartOffsets(tokens) {
  if (tokens.length < 6) return [];
  // Three opening words identify a restart unless all three are filler words.
  const size = tokens.slice(0, 3).some((t) => t.content) ? 3 : 4;
  const key = tokens.slice(0, size).map((t) => t.stem).join(" ");
  const offsets = [];
  for (let k = size; k + size <= tokens.length; k++) {
    if (tokens.slice(k, k + size).map((t) => t.stem).join(" ") === key) {
      offsets.push(k);
      k += size - 1;
    }
  }
  return offsets;
}

export function buildTakeUnits(segments) {
  const units = [];
  segments.forEach((segment, segmentIndex) => {
    const text = String(segment?.text ?? "");
    const tokens = tokenize(text);
    if (!tokens.some((t) => /\p{L}/u.test(t.word)) || SOUND_ANNOTATION.test(text) || !(segment.end > segment.start)) return;
    const timing = new Map(savedWordTiming(segment).map((w) => [w.startChar, w]));
    // Mid-segment cuts need measured word times; otherwise keep the segment whole.
    const restarts = internalRestartOffsets(tokens);
    const splits = restarts.filter((k) => timing.has(tokens[k].startChar) && timing.has(tokens[k - 1].startChar));
    // Judge an untimed segment's quality by its last attempt, not its abandoned opening.
    const lastAttemptText = restarts.length ? text.slice(tokens[restarts.at(-1)].startChar) : null;
    const bounds = [0, ...splits, tokens.length];
    for (let b = 0; b + 1 < bounds.length; b++) {
      const part = tokens.slice(bounds[b], bounds[b + 1]);
      const first = part[0], last = part.at(-1);
      const startChar = first.startChar;
      const endChar = b + 2 === bounds.length ? text.trimEnd().length : last.endChar;
      units.push({
        segmentIndex,
        startChar,
        endChar,
        text: text.slice(startChar, endChar).trim(),
        start: b === 0 ? segment.start : timing.get(first.startChar).start,
        end: b + 2 === bounds.length ? segment.end : timing.get(last.startChar).end,
        tokens: part,
        internal: b > 0,
        lastAttemptText: b + 2 === bounds.length && splits.at(-1) !== restarts.at(-1) ? lastAttemptText : null,
      });
    }
  });
  return units;
}

// How strongly does `later` look like a new attempt at the line `earlier` started?
// Returns 0 (unrelated), 1 (shared content words) or 2 (same opening).
export function restartStrength(earlier, later) {
  const a = earlier.tokens, b = later.tokens;
  // A single word ("Угу.", "Так.") does not identify a line of the script.
  if (a.length < 2 || b.length < 2) return 0;
  const firstContentA = a.slice(0, 6).find((t) => t.content);
  const firstContentB = b.slice(0, 6).find((t) => t.content);
  // An identical multi-word opening is a restart even when it is built from
  // common words ("здесь я бы в первую очередь…").
  const openA = withoutLeadingFillers(a), openB = withoutLeadingFillers(b);
  let prefix = 0;
  while (prefix < openA.length && prefix < openB.length && openA[prefix].stem === openB[prefix].stem) prefix++;
  const sameOpening = prefix >= 4 || (prefix >= 2 && openA.slice(0, prefix).some((t) => t.content));
  const sameFirstContent = Boolean(firstContentA && firstContentB && firstContentA.stem === firstContentB.stem);
  const sameFirstTwo = a.length >= 2 && b.length >= 2 && a[0].stem === b[0].stem && a[1].stem === b[1].stem && (a[0].content || a[1].content);
  const laterContent = new Set(contentStems(b, 6));
  const earlierContent = contentStems(a, 6);
  const shared = earlierContent.filter((s) => laterContent.has(s)).length;
  // An abandoned attempt followed by speech reusing its key words is a restart.
  if (UNFINISHED.test(earlier.text) && shared >= 2) return 2;
  if (sameOpening || sameFirstTwo || (sameFirstContent && (a[0].stem === b[0].stem || shared >= 2 || a.length <= 4))) return 2;
  if (shared >= 3 || (earlierContent.length >= 2 && shared === earlierContent.length && a.length <= 6)) return 1;
  return 0;
}

const looksBroken = (unit) => { const text = unit.lastAttemptText ?? unit.text; return UNFINISHED.test(text) || PROFANITY.test(text) || RECORDING_COMMAND.test(text); };

export function detectLastTakeEdits(segments, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const units = buildTakeUnits(segments ?? []);

  // 1. For each unit, link it to the nearest earlier unit whose line it restarts.
  //    Internal splits are restarts by construction.
  const links = [];
  for (let j = 1; j < units.length; j++) {
    if (units[j].internal) {
      links.push({ earlier: j - 1, later: j, strength: 2 });
      continue;
    }
    for (let i = j - 1; i >= 0 && j - i <= settings.maxLookbackUnits && units[j].start - units[i].start <= settings.maxLookbackSeconds; i--) {
      const strength = restartStrength(units[i], units[j]);
      if (strength) { links.push({ earlier: i, later: j, strength }); break; }
    }
  }

  // 2. Chains: follow links forward to find each attempt's final take.
  const nextOf = new Map();
  for (const link of links) if (!nextOf.has(link.earlier) || nextOf.get(link.earlier) > link.later) nextOf.set(link.earlier, link.later);
  const finalOf = (index) => { let current = index; while (nextOf.has(current)) current = nextOf.get(current); return current; };
  const attemptUnits = new Set(links.flatMap((l) => [l.earlier, l.later]));

  // 3. Final takes are protected. Takes can interleave: A1, B1, A2, B2 keeps
  //    A2 and B2, so the B1→B2 cut must step around A2.
  const earlierUnits = new Set(links.map((l) => l.earlier));
  const keptFinals = new Set(links.map((l) => l.later).filter((k) => !earlierUnits.has(k)));

  // 4. Each link removes the earlier attempt and everything up to the restart,
  //    except other lines' final takes. One candidate per contiguous run.
  const candidates = [];
  for (const link of links) {
    const final = finalOf(link.later);
    const between = units.slice(link.earlier + 1, link.later).filter((_, k) => !attemptUnits.has(link.earlier + 1 + k));
    const interveningWords = between.reduce((sum, u) => sum + u.tokens.length, 0);
    let confidence = link.strength === 2 ? 0.95 : 0.85;
    const notes = [];
    if (interveningWords > settings.maxInterveningWords) { confidence -= 0.2; notes.push("Other speech lies between the two attempts; check this is a retake and not a repeated sentence pattern."); }
    if (looksBroken(units[final])) { confidence = Math.min(confidence, 0.75); notes.push("The last attempt itself looks unfinished or flawed; choose which take to keep."); }
    const runs = [];
    for (let k = link.earlier; k < link.later; k++) {
      if (keptFinals.has(k)) continue;
      if (runs.at(-1)?.at(-1) === k - 1) runs.at(-1).push(k);
      else runs.push([k]);
    }
    for (const run of runs) {
      candidates.push({
        start: units[run[0]].start,
        end: units[run.at(-1)].end,
        reason: units[link.earlier].tokens.length < units[link.later].tokens.length ? "false-start" : "repeated-take",
        confidence: Number(confidence.toFixed(2)),
        similarity: link.strength === 2 ? 1 : 0.5,
        removedText: run.map((k) => units[k].text).join(" "),
        keptText: units[final].text,
        keptRanges: [{ start: units[final].start, end: units[final].end }],
        method: LAST_TAKE_MODE,
        canApply: true,
        autoEligible: confidence >= settings.autoConfidence,
        groupId: `take:${units[final].segmentIndex}:${units[final].startChar}`,
        attemptId: `${units[run[0]].segmentIndex}:${units[run[0]].startChar}`,
        winnerId: `${units[final].segmentIndex}:${units[final].startChar}`,
        reviewNote: notes.join(" ") || (link.strength === 2 ? "Restarts the same opening; the later attempt is kept." : "Shares the key words of a later attempt; the later attempt is kept."),
      });
    }
  }

  // 5. Recording commands ("погнали", "ещё раз") outside any retake.
  for (const unit of units) {
    if (unit.tokens.length > 6 || attemptUnits.has(units.indexOf(unit))) continue;
    const strong = RECORDING_COMMAND.test(unit.text);
    const soft = !strong && SOFT_COMMAND.test(unit.text);
    if (!strong && !soft) continue;
    const confidence = strong ? 0.92 : 0.8;
    candidates.push({
      start: unit.start, end: unit.end, reason: "false-start", confidence, similarity: 0,
      removedText: unit.text, keptText: "", method: LAST_TAKE_MODE, canApply: true,
      autoEligible: confidence >= settings.autoConfidence,
      groupId: `command:${unit.segmentIndex}:${unit.startChar}`,
      reviewNote: "Sounds like a recording instruction rather than part of the script.",
    });
  }

  candidates.sort((a, b) => a.start - b.start || a.end - b.end);
  const applied = candidates.filter((c) => c.autoEligible);
  return {
    candidates,
    applied,
    summary: {
      reviewPolicy: LAST_TAKE_POLICY,
      units: units.length,
      restartLinks: links.length,
      chains: new Set(candidates.filter((c) => c.groupId).map((c) => c.groupId)).size,
      applied: applied.length,
    },
  };
}
