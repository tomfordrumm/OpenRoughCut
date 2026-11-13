#!/usr/bin/env node
// Score a duplicate-take detector against an author's finished edit.
//
//   node scripts/eval-takes.mjs <author.roughcut> [--transcript other.json] [--mode last-take|rules] [-v]
//
// The gold standard is the author's final plan (automatic removals with every
// manual keep/remove applied). Each transcript segment counts as "removed" when
// at least half of it lies inside removed ranges. Non-word segments (hums,
// single interjections without letters) are ignored: they belong to the
// non-verbal detector, not to take selection.
import { readFile } from "node:fs/promises";
import { applyManualOverrides } from "@openroughcut/core/edit-plan.js";
import { detectLastTakeEdits } from "@openroughcut/core/last-take.js";
import { detectTextEdits } from "@openroughcut/core/text-edits.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const verbose = args.includes("-v") ? (args.splice(args.indexOf("-v"), 1), true) : false;
const transcriptPath = flag("--transcript");
const mode = flag("--mode") ?? "last-take";
const sessionPath = args[0];
if (!sessionPath) {
  console.error("Usage: node scripts/eval-takes.mjs <author.roughcut> [--transcript file.json] [--mode last-take|rules] [-v]");
  process.exit(2);
}

const session = JSON.parse(await readFile(sessionPath, "utf8"));
const fps = session.media.frameRate.numerator / session.media.frameRate.denominator;
const durationFrames = Math.round(session.media.duration * fps);
const overrides = session.manualOverrides.map((o) => ({ ...o, startFrame: o.start * fps, endFrame: o.end * fps }));
const final = applyManualOverrides(session.analysis.automaticRemovals, overrides, durationFrames);
const gold = (final.removals ?? final).map((r) => ({ start: r.startFrame / fps, end: r.endFrame / fps }));

const segments = transcriptPath
  ? JSON.parse(await readFile(transcriptPath, "utf8")).segments
  : session.analysis.transcript.segments;

const result = mode === "rules"
  ? detectTextEdits(segments, { autoConfidence: session.textConfidence ?? 0.9 })
  : detectLastTakeEdits(segments);

const covered = (segment, ranges) => ranges.reduce((total, r) => total + Math.max(0, Math.min(segment.end, r.end) - Math.max(segment.start, r.start)), 0) / (segment.end - segment.start);
const isWords = (text) => /\p{L}{2,}/u.test(text) && !/^[\s\p{P}]*(?:м+|мм+|э+|а+)[\s\p{P}]*$/iu.test(text);
const time = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const rows = { tp: [], fp: [], fn: [], suggestedOnly: [] };
for (const segment of segments) {
  if (!isWords(segment.text)) continue;
  const removed = covered(segment, gold) >= 0.5;
  const applied = covered(segment, result.applied) >= 0.5;
  const suggested = covered(segment, result.candidates) >= 0.5;
  const line = `${time(segment.start)}  ${segment.text}`;
  if (removed && applied) rows.tp.push(line);
  else if (applied) rows.fp.push(line);
  else if (removed) (suggested ? rows.suggestedOnly : rows.fn).push(line);
}
const tp = rows.tp.length, fp = rows.fp.length, fn = rows.fn.length + rows.suggestedOnly.length;
const ratio = (a, b) => (b ? (a / b).toFixed(2) : "n/a");
console.log(`mode=${mode} segments=${segments.length} candidates=${result.candidates.length} applied=${result.applied.length}`);
console.log(`applied:   precision=${ratio(tp, tp + fp)} recall=${ratio(tp, tp + fn)}  (TP=${tp} FP=${fp} FN=${fn}, of which ${rows.suggestedOnly.length} only suggested)`);
if (verbose) {
  console.log("\nWrongly removed (author kept):\n" + (rows.fp.join("\n") || "—"));
  console.log("\nSuggested but not applied (author removed):\n" + (rows.suggestedOnly.join("\n") || "—"));
  console.log("\nMissed (author removed):\n" + (rows.fn.join("\n") || "—"));
}
