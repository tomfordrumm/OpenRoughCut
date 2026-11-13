import React, { useEffect, useMemo, useRef, useState } from "react";
import { reviewChains, wordDiff } from "../../src/transcript-review.js";
import { t } from "./i18n.js";

const clock = (n) => (n == null ? t("boundaryMissing") : `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`);
const HIDE_REMOVED_KEY = "openroughcut.hideRemoved";
// Where the review was left, per transcript, so switching to the timeline and
// back returns to the same line.
const positions = new WeakMap();
const readFlag = (key) => { try { return window.localStorage.getItem(key) === "1"; } catch { return false; } };
const writeFlag = (key, on) => { try { window.localStorage.setItem(key, on ? "1" : "0"); } catch {} };

function Diff({ text, reference, enabled }) {
  if (!enabled || !reference) return text;
  return wordDiff(text, reference).map((part, i) => (part.changed ? <mark key={i}>{part.text}</mark> : <React.Fragment key={i}>{part.text}</React.Fragment>));
}

const whyLabel = (candidate) => candidate.requiresFactConfirmation ? t("whyFact")
  : candidate.requiresQualityConfirmation ? t("whyQuality")
    : candidate.requiresContextConfirmation ? t("whyContext")
      : candidate.canApply === false ? t("noBounds") : t("why");

/**
 * Review of re-recorded lines ("chains") and of the full transcript.
 * Edits go through onEdit/onBatch as manual overrides, so undo covers them.
 */
export default function TranscriptReview({ transcript, candidates, removals, manualOverrides, rate, currentTime, playing, active, onSeek, onPlayRange, onEdit, onBatch, onUndo, canUndo }) {
  const segments = transcript?.segments ?? [];
  const removedRange = (start, end) => start != null && removals.some((r) => r.startFrame / rate <= start + 0.05 && r.endFrame / rate >= end - 0.05);
  const decided = (candidate) => manualOverrides.some((o) => o.start <= candidate.start + 0.05 && o.end >= candidate.end - 0.05);

  const chains = useMemo(() => reviewChains(segments, candidates)
    .map((chain) => ({ ...chain, takes: chain.takes.filter((take) => take.text) }))
    .filter((chain) => chain.takes.length), [segments, candidates]);
  // A suggestion waits for review until the user decided it, or another edit
  // already removed its range.
  const pendingOf = (chain) => chain.candidates.filter((c) => !c.applied && c.reason !== "non-verbal" && c.canApply !== false && !decided(c) && !removedRange(c.start, c.end));
  const pendingIndices = chains.map((chain, i) => (pendingOf(chain).length ? i : -1)).filter((i) => i >= 0);

  const remembered = positions.get(transcript);
  const [mode, setMode] = useState(remembered?.mode ?? "chains");
  const [index, setIndex] = useState(() => remembered?.index ?? pendingIndices[0] ?? 0);
  useEffect(() => { if (transcript) positions.set(transcript, { mode, index }); }, [transcript, mode, index]);
  const [showDiff, setShowDiff] = useState(false);
  const [hideRemoved, setHideRemoved] = useState(() => readFlag(HIDE_REMOVED_KEY));
  const [expandedRuns, setExpandedRuns] = useState(() => new Set());
  const [notice, setNotice] = useState("");
  const scrollRef = useRef(null);
  const currentRowRef = useRef(null);

  const safeIndex = Math.min(index, Math.max(0, chains.length - 1));
  const chain = chains[safeIndex];
  const go = (next) => { setIndex(Math.max(0, Math.min(chains.length - 1, next))); setNotice(""); };
  const nextPending = (from = safeIndex) => pendingIndices.find((i) => i > from) ?? pendingIndices.find((i) => i !== from);

  // Takes in speaking order get stable numbers; kept ones are shown first.
  const view = useMemo(() => {
    if (!chain) return null;
    const takes = chain.takes.map((take, i) => ({ ...take, number: i + 1, removed: removedRange(take.start, take.end), precise: take.start != null && take.candidate?.canApply !== false }));
    const kept = takes.filter((take) => !take.removed);
    const gone = takes.filter((take) => take.removed);
    const reference = kept.at(-1) ?? takes.find((take) => take.selected) ?? takes.at(-1);
    return { takes, kept, gone, reference };
  }, [chain, removals, rate]);

  const pending = chain ? pendingOf(chain) : [];
  const accept = () => {
    if (!pending.length) return;
    onBatch(pending.map((c) => ({ action: "remove", start: c.start, end: c.end })));
    setNotice(t("accepted"));
    const next = nextPending();
    if (next != null) setIndex(next);
  };
  const reject = () => {
    if (!pending.length) return;
    onBatch(pending.map((c) => ({ action: "keep", start: c.start, end: c.end })));
    setNotice(t("rejected"));
    const next = nextPending();
    if (next != null) setIndex(next);
  };
  const choose = (take) => {
    if (!view || !take.precise || view.takes.some((other) => !other.precise)) return;
    onBatch(view.takes.map((other) => ({ action: other === take ? "keep" : "remove", start: other.start, end: other.end })));
    setNotice(t("keptOnly", { n: take.number }));
  };
  const playJoin = () => {
    if (!view) return;
    const timed = view.takes.filter((take) => take.start != null);
    if (!timed.length) return;
    const first = Math.min(...timed.map((take) => take.start));
    const last = view.kept.filter((take) => take.start != null).at(-1) ?? timed.at(-1);
    onPlayRange(Math.max(0, first - 1.5), last.end + 0.5, { edited: true });
  };

  useEffect(() => {
    if (!active || mode !== "chains") return undefined;
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      const key = event.key.toLowerCase();
      if (key === "j" || event.key === "ArrowDown") { event.preventDefault(); go(safeIndex + 1); }
      else if (key === "k" || event.key === "ArrowUp") { event.preventDefault(); go(safeIndex - 1); }
      else if (key === "n") { const next = nextPending(); if (next != null) go(next); }
      else if (event.key === "Enter") {
        if (document.activeElement?.tagName === "BUTTON") return; // the focused button handles Enter itself
        event.preventDefault(); accept();
      }
      else if (key === "x") reject();
      else if (key === "p") playJoin();
      else if (key === "d") setShowDiff((on) => !on);
      else if (/^[1-9]$/.test(key)) { const take = view?.takes[Number(key) - 1]; if (take) choose(take); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Follow playback in the full text.
  const currentSegment = segments.findIndex((s) => currentTime >= s.start && currentTime < s.end);
  useEffect(() => {
    if (mode === "text" && playing) currentRowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [mode, playing, currentSegment]);
  useEffect(() => { scrollRef.current?.scrollTo?.({ top: 0 }); }, [mode, safeIndex]);

  const takeRow = (take) => <article key={`${take.start}-${take.number}`} className={`take-row ${take.removed ? "is-removed" : ""}`}>
    <button className="take-play" disabled={take.start == null} onClick={() => onPlayRange(take.start, take.end, { edited: false })} title={t("listen")} aria-label={`${t("listen")} · ${t("attempt", { n: take.number, time: clock(take.start) })}`}>▶</button>
    <div className="take-body">
      <span className="take-meta"><kbd>{take.number}</kbd>{clock(take.start)}{!take.precise && <em>{t("noBounds")}</em>}</span>
      <p><Diff text={take.text} reference={take === view.reference ? null : view.reference.text} enabled={showDiff} /></p>
      {take.candidate?.reviewNote && <details><summary>{whyLabel(take.candidate)}</summary><p>{take.candidate.reviewNote}</p></details>}
      {!take.precise && segments[take.segmentIndex] && <details className="whole-source"><summary>{t("wholeSource", { from: clock(segments[take.segmentIndex].start), to: clock(segments[take.segmentIndex].end) })}</summary>
        <p>{segments[take.segmentIndex].text}</p>
        <button onClick={() => onPlayRange(segments[take.segmentIndex].start, segments[take.segmentIndex].end, { edited: false })}>{t("listenWhole")}</button>
        <button onClick={() => onEdit("remove", segments[take.segmentIndex].start, segments[take.segmentIndex].end)}>{t("removeWhole")}</button>
        <button onClick={() => onEdit("keep", segments[take.segmentIndex].start, segments[take.segmentIndex].end)}>{t("keepWhole")}</button>
      </details>}
    </div>
    <div className="take-actions">
      {view.takes.length > 1 && <button disabled={!take.precise || view.takes.some((other) => !other.precise)} onClick={() => choose(take)}>{t("chooseThis")}</button>}
      <button className="quiet" disabled={!take.precise} onClick={() => onEdit(take.removed ? "keep" : "remove", take.start, take.end)}>{take.removed ? t("restore") : t("removeShort")}</button>
    </div>
  </article>;

  const chainsView = !chain ? <p className="review-empty">{t("noChains")}</p> : <>
    <div className="chain-navigation">
      <button onClick={() => go(safeIndex - 1)} disabled={safeIndex === 0} aria-label={t("previous")}>‹</button>
      <strong>{t("chainOf", { index: safeIndex + 1, total: chains.length, time: clock(chain.start) })}</strong>
      <button onClick={() => go(safeIndex + 1)} disabled={safeIndex >= chains.length - 1} aria-label={t("next")}>›</button>
      <span className={`chain-state ${pending.length ? "pending" : "done"}`}>{pending.length ? t("needsDecision") : t("reviewed")}</span>
    </div>
    {pending.length > 0 && <div className="decision-bar">
      <span>{t("suggestion", { count: pending.length })}</span>
      <button className="primary" onClick={accept}>{t("accept")} <kbd>⏎</kbd></button>
      <button onClick={reject}>{t("reject")} <kbd>X</kbd></button>
    </div>}
    {view.kept.length > 0 && <section className="take-group kept">
      <header><span>{t("stays")}</span><button className="link" onClick={playJoin} title={t("listenJoinHint")}>▶ {t("listenJoin")} <kbd>P</kbd></button></header>
      {view.kept.map(takeRow)}
    </section>}
    {view.takes.length === 1 && !view.kept.length && <p className="review-note">{t("commandOnly")}</p>}
    {view.gone.length > 0 && <section className="take-group gone">
      <header><span>{t("removed", { count: view.gone.length })}</span>
        <label className="toggle"><input type="checkbox" checked={showDiff} onChange={(event) => setShowDiff(event.target.checked)} /> {t("showDiff")} <kbd>D</kbd></label></header>
      {showDiff && <p className="diff-key">{t("diffHint")}</p>}
      {view.gone.map(takeRow)}
    </section>}
    <p className="review-notice" role="status">{notice}</p>
  </>;

  // Full text: consecutive removed segments can collapse into one line.
  const textView = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isRemoved = removedRange(segment.start, segment.end);
    if (hideRemoved && isRemoved && !expandedRuns.has(i)) {
      let j = i;
      while (j + 1 < segments.length && removedRange(segments[j + 1].start, segments[j + 1].end)) j++;
      const duration = segments.slice(i, j + 1).reduce((sum, s) => sum + (s.end - s.start), 0);
      const runStart = i;
      textView.push(<button key={`run-${i}`} className="hidden-run" onClick={() => setExpandedRuns((set) => new Set([...set, ...Array.from({ length: j - runStart + 1 }, (_, k) => runStart + k)]))}>{t("hiddenRun", { count: j - i + 1, duration: duration < 60 ? t("seconds", { value: duration.toFixed(1) }) : clock(duration) })}</button>);
      i = j;
      continue;
    }
    const related = chains.findIndex((g) => g.takes.some((take) => take.segmentIndex === i));
    textView.push(<article key={i} ref={i === currentSegment ? currentRowRef : null} className={`text-row ${i === currentSegment ? "is-current" : ""} ${isRemoved ? "is-removed" : ""}`}>
      <button className="text-time" onClick={() => onSeek(segment.start)}>{clock(segment.start)}</button>
      <p onClick={() => onSeek(segment.start)}>{segment.text}</p>
      <div className="row-actions">
        <button onClick={() => onPlayRange(segment.start, segment.end, { edited: false })} title={t("listen")} aria-label={t("listen")}>▶</button>
        <button onClick={() => onEdit(isRemoved ? "keep" : "remove", segment.start, segment.end)}>{isRemoved ? t("restoreFragment") : t("removeFragment")}</button>
        {related >= 0 && <button onClick={() => { setIndex(related); setMode("chains"); }}>{t("compareTakes")}</button>}
      </div>
    </article>);
  }

  return <section className="text-review panel">
    <header className="text-review-header">
      <div><h2>{t("textTitle")}</h2><p>{t("textSubtitle")}</p></div>
      <button onClick={() => { setNotice(""); onUndo(); }} disabled={!canUndo}>{t("undoShort")}</button>
    </header>
    <div className="review-tabs">
      <button aria-pressed={mode === "chains"} onClick={() => setMode("chains")}>{t("tabChains", { count: chains.length })}</button>
      <button aria-pressed={mode === "text"} onClick={() => setMode("text")}>{t("tabText")}</button>
      {mode === "chains" ? <span className={`queue ${pendingIndices.length ? "pending" : "done"}`}>
        {t("toReview", { count: pendingIndices.length })}
        {pendingIndices.length > 0 && <button className="link" onClick={() => { const next = nextPending(); if (next != null) go(next); }}>{t("nextToReview")} <kbd>N</kbd></button>}
      </span> : <label className="toggle queue"><input type="checkbox" checked={hideRemoved} onChange={(event) => { setHideRemoved(event.target.checked); writeFlag(HIDE_REMOVED_KEY, event.target.checked); setExpandedRuns(new Set()); }} /> {t("hideRemoved")}</label>}
    </div>
    <div className="review-scroll" ref={scrollRef}>{mode === "chains" ? chainsView : textView}</div>
    {mode === "chains" && chain && <footer className="review-keys">{t("keys")}</footer>}
  </section>;
}
