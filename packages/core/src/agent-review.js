// Agent review: hand the transcript and the detector's take decisions to an
// outside agent (an LLM driving the CLI), then apply its decisions without
// transcribing again.
//
//   1. openroughcut video.mov --review video.review.json
//      → timeline with the detector's own cuts, plus a review packet.
//   2. The agent writes decisions.json (keep / remove / cut, each with a reason).
//   3. openroughcut video.mov --decisions decisions.json
//      → timeline rebuilt from the packet's transcript and the agent's decisions.
//
// The agent only ever names transcript units and candidates by id. Every cut it
// asks for therefore starts and ends on measured speech boundaries.
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { buildTakeUnits } from "./last-take.js";

export const REVIEW_FORMAT = "openroughcut-review-v1";
export const DECISIONS_FORMAT = "openroughcut-decisions-v1";

const round = (value) => Number(Number(value).toFixed(3));
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const normalize = (text) => String(text ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const SAMPLE_BYTES = 4 * 1024 * 1024;

/**
 * Identify a recording by its size and a hash of its first and last 4 MiB.
 * Fast on multi-gigabyte files, and unlike the duration it differs between
 * two takes of the same length.
 */
export async function sourceFingerprint(filePath) {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const hash = createHash("sha256").update(`${size}\0`);
    const head = Math.min(SAMPLE_BYTES, size);
    const tail = Math.min(SAMPLE_BYTES, size - head);
    for (const [position, length] of [[0, head], [size - tail, tail]]) {
      if (!length) continue;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { sizeBytes: size, sampleSha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

/** Throw unless the packet was made from this exact recording. */
export function assertSameSource(packet, fingerprint, durationSeconds, reviewPath = "The review packet") {
  const input = packet?.input ?? {};
  if (typeof input.sampleSha256 !== "string" || !Number.isFinite(input.sizeBytes)) {
    throw new Error(`${reviewPath} does not identify its recording; create it again with --review.`);
  }
  if (input.sizeBytes !== fingerprint.sizeBytes || input.sampleSha256 !== fingerprint.sampleSha256
    || Math.abs(Number(input.durationSeconds) - durationSeconds) > 0.05) {
    throw new Error(`${reviewPath} was made for a different recording (${input.path ?? "unknown"}); its transcript and cuts do not apply to this file.`);
  }
}

/**
 * Units holding the take a candidate keeps. Detectors describe it differently:
 * last-take by unit id or time ranges, rules only by text. An empty result means the kept take could not be located.
 */
function keptUnitIndices(candidate, units) {
  if (candidate.winnerId) {
    const index = units.findIndex((unit) => `${unit.segmentIndex}:${unit.startChar}` === candidate.winnerId);
    if (index >= 0) return [index];
  }
  const ranges = Array.isArray(candidate.keptRanges) ? candidate.keptRanges.filter((r) => r && r.end > r.start) : [];
  if (ranges.length) {
    const found = units.flatMap((unit, k) => (ranges.some((r) => overlap(unit, r) >= (unit.end - unit.start) / 2) ? [k] : []));
    if (found.length) return found;
  }
  const target = normalize(candidate.keptText);
  if (!target) return [];
  // The kept take is spoken after the removed one: the nearest run of up to
  // four units whose text is the kept text.
  for (let i = 0; i < units.length; i++) {
    if (units[i].start < candidate.start || overlap(units[i], candidate) > 0) continue;
    let joined = "";
    for (let j = i; j < Math.min(units.length, i + 4); j++) {
      joined = `${joined} ${normalize(units[j].text)}`.trim();
      if (joined === target || (joined.includes(target) && target.length >= joined.length * 0.6)) return Array.from({ length: j - i + 1 }, (_, k) => i + k);
      if (joined.length > target.length * 1.7) break;
    }
  }
  return [];
}

export const REVIEW_INSTRUCTIONS = [
  "This is a talking-head recording. The speaker re-records lines until satisfied: the LAST complete attempt of a line is the good one; every earlier attempt, false start, recording command (\"давай ещё раз\", \"заново\", \"погнали\", \"стоп\") and aside to the crew should be cut.",
  "`units` is the transcript in speaking order. `cutBy` names the candidate that currently removes a unit; null means the unit is kept.",
  "`candidates` are the detector's findings. applied=true is already cut; applied=false is a suggestion that is NOT cut. `keptUnits` hold the take the detector keeps instead. A candidate with timed=false has no exact word bounds and cannot be applied; cut its units instead only if every word in them is a retake.",
  "Write a decisions file shaped like `decisionsTemplate`, then run `applyCommand` with its path: `keep` restores applied candidates, `remove` applies suggestions, `cut` removes further units the detector missed (each entry is a run of consecutive unit ids). Give every decision a short `reason`.",
  "A line said only once is content, not a retake: never cut it. A reworded earlier attempt of a later line IS a retake. When unsure, leave the unit as it is.",
  "To keep an earlier take instead of the last one, `keep` the candidate and `cut` the later take's units.",
];

function unitId(index) { return `u${index + 1}`; }

/** Build the packet an agent reads. `applied` lists the edits actually cut. */
export function buildReviewPacket({ inputPath, fingerprint, media, transcript, textEdits, applied, settings, reviewPath, outputPath, applyCommand }) {
  const takeUnits = buildTakeUnits(transcript?.segments ?? []);
  const sorted = [...(textEdits?.candidates ?? [])].sort((a, b) => a.start - b.start || a.end - b.end);
  const candidates = sorted.map((candidate, index) => {
    const covered = takeUnits.map((unit, k) => (overlap(unit, candidate) >= (unit.end - unit.start) / 2 ? unitId(k) : null)).filter(Boolean);
    const kept = keptUnitIndices(candidate, takeUnits).map(unitId);
    return {
      id: `c${index + 1}`,
      applied: applied.includes(candidate),
      units: covered,
      start: round(candidate.start),
      end: round(candidate.end),
      reason: candidate.reason ?? null,
      confidence: candidate.confidence ?? null,
      removedText: candidate.removedText ?? null,
      timed: candidate.canApply !== false,
      keptUnit: kept[0] ?? null,
      keptUnits: kept,
      keptText: candidate.keptText ?? null,
      note: candidate.reviewNote ?? null,
      source: candidate,
    };
  });
  const units = takeUnits.map((unit, k) => ({
    id: unitId(k),
    start: round(unit.start),
    end: round(unit.end),
    text: unit.text,
    cutBy: candidates.find((c) => c.applied && c.units.includes(unitId(k)))?.id ?? null,
  }));
  return {
    format: REVIEW_FORMAT,
    input: { path: inputPath, durationSeconds: media.duration, ...fingerprint },
    output: outputPath,
    settings,
    reviewPolicy: textEdits?.summary?.reviewPolicy ?? null,
    instructions: REVIEW_INSTRUCTIONS,
    applyCommand: applyCommand ?? `openroughcut ${JSON.stringify(inputPath)} --decisions <decisions.json>`,
    decisionsTemplate: {
      format: DECISIONS_FORMAT,
      review: reviewPath,
      keep: [],
      remove: [],
      cut: [],
    },
    units,
    candidates: candidates.map(({ source, ...rest }) => rest),
    // Kept whole so --decisions can rebuild the timeline without Whisper.
    candidateSources: candidates.map((c) => c.source),
    transcript,
  };
}

function fail(message) { throw new Error(`Invalid decisions: ${message}`); }
// How far after a candidate an unlocated kept take may lie (the detectors' lookback).
const UNLOCATED_WINDOW_SECONDS = 90;

function decisionEntries(list, field) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail(`\`${field}\` must be an array.`);
  return list.map((entry) => {
    if (typeof entry === "string") return { id: entry, reason: null };
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") fail(`each \`${field}\` entry needs an \`id\`.`);
    return { id: entry.id, reason: typeof entry.reason === "string" ? entry.reason : null };
  });
}

/** Check a review packet read from disk before trusting its contents. */
export function assertReviewPacket(packet) {
  if (packet?.format !== REVIEW_FORMAT) throw new Error(`The review file is not an ${REVIEW_FORMAT} packet.`);
  if (!Array.isArray(packet.units) || !Array.isArray(packet.candidates) || !Array.isArray(packet.candidateSources)
    || packet.candidates.length !== packet.candidateSources.length || !Array.isArray(packet.transcript?.segments)) {
    throw new Error("The review packet is incomplete; create it again with --review.");
  }
  return packet;
}

/**
 * Turn an agent's decisions into text edits shaped like a detector result.
 * Unknown ids, contradictory decisions and gaps inside a cut are errors: an
 * agent's typo must never silently become a different edit.
 */
export function applyAgentDecisions(packet, decisions) {
  assertReviewPacket(packet);
  if (decisions?.format !== DECISIONS_FORMAT) fail(`\`format\` must be "${DECISIONS_FORMAT}".`);
  const allowed = new Set(["format", "review", "keep", "remove", "cut", "notes"]);
  for (const key of Object.keys(decisions)) if (!allowed.has(key)) fail(`unknown field \`${key}\`.`);

  const byId = new Map(packet.candidates.map((c, i) => [c.id, { view: c, source: packet.candidateSources[i] }]));
  const unitIndex = new Map(packet.units.map((u, i) => [u.id, i]));
  const keep = decisionEntries(decisions.keep, "keep");
  const remove = decisionEntries(decisions.remove, "remove");
  const seen = new Map();
  for (const [field, list] of [["keep", keep], ["remove", remove]]) {
    for (const entry of list) {
      const candidate = byId.get(entry.id);
      if (!candidate) fail(`\`${field}\` names unknown candidate ${entry.id}.`);
      if (seen.has(entry.id)) fail(`${entry.id} appears in both \`${seen.get(entry.id)}\` and \`${field}\`.`);
      seen.set(entry.id, field);
      if (field === "keep" && !candidate.view.applied) fail(`${entry.id} is not cut, so it cannot be kept; leave it out.`);
      if (field === "remove" && candidate.view.applied) fail(`${entry.id} is already cut; leave it out.`);
      if (field === "remove" && (candidate.view.timed === false || candidate.source?.canApply === false)) {
        fail(`${entry.id} has no exact word timing, so applying it could remove speech around it. Cut its units instead if every word in them is a retake.`);
      }
    }
  }

  const keptIds = new Set(keep.map((e) => e.id));
  const removedIds = new Set(remove.map((e) => e.id));
  const appliedCandidates = packet.candidates.filter((c) => (c.applied && !keptIds.has(c.id)) || removedIds.has(c.id));
  // Packets written before keptUnits existed only carry keptUnit.
  const keptOf = (c) => (Array.isArray(c.keptUnits) ? c.keptUnits : c.keptUnit ? [c.keptUnit] : []);

  // Applying a suggestion must leave the take it keeps in the video.
  for (const id of removedIds) {
    const candidate = byId.get(id).view;
    const kept = keptOf(candidate);
    if (candidate.keptText && !kept.length) fail(`the take ${id} keeps could not be located in \`units\`, so applying it could remove both versions. Cut the earlier units instead.`);
    const lost = kept.filter((unitIdValue) => appliedCandidates.some((other) => other !== candidate && other.units.includes(unitIdValue)));
    if (kept.length && lost.length === kept.length) fail(`${id} keeps ${kept.join(", ")}, which another cut already removes; both versions would be lost.`);
    const victim = appliedCandidates.find((other) => other !== candidate && keptOf(other).some((u) => candidate.units.includes(u)));
    if (victim) fail(`${id} would remove ${keptOf(victim).filter((u) => candidate.units.includes(u)).join(", ")}, the take ${victim.id} keeps; both versions would be lost.`);
  }

  if (decisions.cut !== undefined && !Array.isArray(decisions.cut)) fail("`cut` must be an array.");
  const cutUnits = new Set();
  const agentCuts = (decisions.cut ?? []).map((entry, n) => {
    const ids = entry?.units;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== "string")) fail(`cut #${n + 1} needs a non-empty \`units\` array of unit ids.`);
    const indices = ids.map((id) => {
      if (!unitIndex.has(id)) fail(`cut #${n + 1} names unknown unit ${id}.`);
      if (cutUnits.has(id)) fail(`unit ${id} is cut twice.`);
      cutUnits.add(id);
      return unitIndex.get(id);
    }).sort((a, b) => a - b);
    for (let k = 1; k < indices.length; k++) {
      if (indices[k] !== indices[k - 1] + 1) fail(`cut #${n + 1} skips ${packet.units[indices[k - 1] + 1].id}; split it into separate cuts.`);
    }
    for (const index of indices) {
      const unit = packet.units[index];
      const protector = appliedCandidates.find((c) => keptOf(c).includes(unit.id));
      if (protector) fail(`${unit.id} is the take ${protector.id} keeps; also \`keep\` ${protector.id} if an earlier take should replace it.`);
      if (appliedCandidates.some((c) => c.units.includes(unit.id))) fail(`${unit.id} is already cut by a candidate.`);
      const unlocated = appliedCandidates.find((c) => c.keptText && !keptOf(c).length && unit.start >= c.start && unit.start - c.start <= UNLOCATED_WINDOW_SECONDS);
      if (unlocated) fail(`${unit.id} may be the take ${unlocated.id} keeps, which could not be located; \`keep\` ${unlocated.id} first if both should go.`);
    }
    const first = packet.units[indices[0]], last = packet.units[indices.at(-1)];
    return {
      start: first.start,
      end: last.end,
      reason: "agent-cut",
      confidence: 1,
      method: "agent",
      canApply: true,
      autoEligible: true,
      groupId: `agent:${first.id}`,
      removedText: indices.map((i) => packet.units[i].text).join(" "),
      keptText: null,
      reviewNote: typeof entry.reason === "string" ? entry.reason : null,
    };
  });

  const sources = packet.candidates.map((c, i) => packet.candidateSources[i]);
  const applied = [
    ...packet.candidates.flatMap((c, i) => (appliedCandidates.includes(c) ? [sources[i]] : [])),
    ...agentCuts,
  ];
  return {
    candidates: [...sources, ...agentCuts],
    applied,
    summary: {
      reviewPolicy: packet.reviewPolicy ?? null,
      agentDecisions: {
        kept: keep,
        removed: remove,
        cut: (decisions.cut ?? []).map((entry) => ({ units: entry.units, reason: typeof entry.reason === "string" ? entry.reason : null })),
        notes: typeof decisions.notes === "string" ? decisions.notes : null,
      },
    },
  };
}
