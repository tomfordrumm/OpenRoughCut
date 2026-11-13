import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { removalAtFrame } from "@openroughcut/core/edit-plan.js";
import { playbackFrameAtTime, playbackJumps, seekTimeAfterRemoval, upcomingJump } from "../../src/playback.js";
import { analysisFingerprint, analysisIsCurrent } from "@openroughcut/core/session.js";
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeTranscriptionModelId } from "@openroughcut/core/transcription-models.js";
import { DEFAULT_DUPLICATE_MODE } from "@openroughcut/core/duplicate-modes.js";
import { resolveProjectResolution } from "@openroughcut/core/project-resolution.js";
import { buildPlan } from "@openroughcut/core/plan.js";
import TranscriptReview from "./transcript-review.jsx";
import { Overview, WaveformCanvas } from "./waveform-view.jsx";
import { localePreference, setLocalePreference, t } from "./i18n.js";
import "./styles.css";

const DEFAULT_SETTINGS = { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18 };
const EMPTY_ANALYSIS = { silences: [], silenceRemovals: [], automaticRemovals: [], textCandidates: [], transcript: null };
const TRANSCRIPTION_MODEL_STORAGE_KEY = "openroughcut.transcriptionModel";
// Pacing presets only set how long a pause must be to cut and how much of it
// stays. The silence threshold depends on the room and microphone instead.
const PACING_PRESETS = {
  tight: { minimumSilence: 0.45, keepPause: 0.12 },
  normal: { minimumSilence: 0.7, keepPause: 0.18 },
  relaxed: { minimumSilence: 1.1, keepPause: 0.3 },
};
const STRENGTHS = { careful: 0.95, balanced: 0.9, bold: 0.8 };
const PROJECT_RESOLUTION_GROUPS = [
  { label: "LANDSCAPE · 16:9", options: [
    { value: "4k", label: "UHD 4K · 3840×2160" },
    { value: "full-hd", label: "Full HD · 1920×1080" },
  ] },
  { label: "VERTICAL · 9:16", options: [
    { value: "vertical-4k", label: "Vertical UHD 4K · 2160×3840" },
    { value: "vertical-full-hd", label: "Vertical Full HD · 1080×1920" },
  ] },
];
const EXPORT_FORMATS = [
  { value: "final-cut", label: "Final Cut Pro", button: "FCPXML", hintKey: "exportHintTimeline" },
  { value: "premiere", label: "Premiere Pro", button: "XML", hintKey: "exportHintTimeline" },
  { value: "resolve", label: "DaVinci Resolve", button: "OTIO", hintKey: "exportHintResolve" },
  { value: "mp4", labelKey: "exportVideo", button: "MP4", hintKey: "exportHintVideo", renders: true },
];
const TIMELINE_VIEW_KEY = "openroughcut.timelineView";

function timecode(value = 0, frameRate = { numerator: 30, denominator: 1 }) {
  const total = Math.max(0, value);
  const fps = frameRate.numerator / frameRate.denominator;
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), Math.floor(total % 60), Math.min(Math.round(fps) - 1, Math.floor((total % 1) * fps))];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}
const clockTime = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

const framesToSeconds = (frames, rate) => frames * rate.denominator / rate.numerator;
const secondsToFrames = (seconds, rate) => Math.round(seconds * rate.numerator / rate.denominator);
const removedSeconds = (ranges, rate) => ranges.reduce((sum, range) => sum + framesToSeconds(range.endFrame - range.startFrame, rate), 0);
const candidateLabel = (reason) => t("labels")[reason] ?? t("labels").silence;
const pacingOf = (settings) => Object.entries(PACING_PRESETS).find(([, preset]) => Math.abs(preset.minimumSilence - settings.minimumSilence) < 0.001 && Math.abs(preset.keepPause - settings.keepPause) < 0.001)?.[0] ?? "custom";
const strengthOf = (confidence) => Object.entries(STRENGTHS).find(([, value]) => Math.abs(value - confidence) < 0.001)?.[0] ?? null;
const formatBytes = (bytes = 0) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** exponent)).toFixed(exponent > 2 ? 2 : 1)} ${units[exponent - 1]}`;
};
const formatDuration = (seconds) => Number.isFinite(seconds) ? timecode(seconds).slice(0, 8) : "—";

function Icon({ children }) { return <span className="icon" aria-hidden="true">{children}</span>; }
function ToolButton({ children, className = "", ...props }) { return <button className={`tool-button ${className}`} {...props}>{children}</button>; }

function Segmented({ label, value, options, onChange, disabled }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className={value === option.value ? "active" : ""} disabled={disabled} onClick={() => onChange(option.value)} title={option.hint}>
      <span>{option.label}</span>{option.hint && <small>{option.hint}</small>}
    </button>)}
  </div>;
}

/** Open state for a dropdown that closes on Escape and when the window loses focus. */
function useDropdown() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKey = (event) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close); // switching to another app
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("blur", close); };
  }, [open]);
  return [open, setOpen];
}

// The title bar is a window drag region whose clicks never reach the page, so
// an invisible layer over the whole window catches the click that closes a menu.
function MenuBackdrop({ onClose }) {
  return <div className="menu-backdrop" onPointerDown={onClose} aria-hidden="true" />;
}

function ExportMenu({ value, disabled, onChange, media, resolution, onResolution }) {
  const [open, setOpen] = useDropdown();
  const current = EXPORT_FORMATS.find((item) => item.value === value) ?? EXPORT_FORMATS[0];
  const label = (item) => (item.labelKey ? t(item.labelKey) : item.label);
  const orientation = media.height > media.width ? t("vertical") : media.width > media.height ? t("landscape") : t("square");
  const sizes = [{ value: "source", label: t("sourceSize", { orientation }), size: `${media.width}×${media.height}` },
    ...PROJECT_RESOLUTION_GROUPS.flatMap((group) => group.options.map((option) => ({ value: option.value, label: option.label.split(" · ")[0], size: option.label.split(" · ")[1] })))];
  return <div className="export-menu">
    {open && <MenuBackdrop onClose={() => setOpen(false)} />}
    <button className="export-trigger" onClick={() => setOpen(!open)} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-label={t("exportLabel")}>
      <span>{label(current)}</span><span className="caret" aria-hidden="true">▾</span>
    </button>
    {open && <div className="menu-popover align-right" role="menu">
      <div className="menu-heading">{t("exportTo")}</div>
      {EXPORT_FORMATS.map((item, i) => <React.Fragment key={item.value}>
        {item.renders && i > 0 && <hr/>}
        <button role="menuitemradio" aria-checked={item.value === value} className={item.value === value ? "checked" : ""} onClick={() => { setOpen(false); onChange(item.value); }}>
          <Icon>{item.value === value ? "✓" : ""}</Icon>
          <span className="menu-item-text"><span>{label(item)}</span><small>{t(item.hintKey)}</small></span>
          <kbd>{item.button}</kbd>
        </button>
      </React.Fragment>)}
      <hr/>
      <div className="menu-heading">{t("frameSize")}{value === "resolve" && <small>{t("setAfterImport")}</small>}</div>
      {sizes.map((item) => <button key={item.value} role="menuitemradio" aria-checked={item.value === resolution} className={`compact ${item.value === resolution ? "checked" : ""}`} onClick={() => onResolution(item.value)}>
        <Icon>{item.value === resolution ? "✓" : ""}</Icon><span>{item.label}</span><kbd>{item.size}</kbd>
      </button>)}
    </div>}
  </div>;
}

function ProjectMenu({ source, autosaveState, runtime, saving, setupBusy, operationBusy, onNew, onOpen, onSave, onClose, onSetup, onLogs, onStorage, onLocale }) {
  const [open, setOpen] = useDropdown();
  const pick = (action) => () => { setOpen(false); action(); };
  const preference = localePreference();
  const item = (label, action, { shortcut, disabled, icon } = {}) => <button role="menuitem" onClick={pick(action)} disabled={disabled}>
    <Icon>{icon}</Icon><span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}
  </button>;
  return <div className="project-menu">
    {open && <MenuBackdrop onClose={() => setOpen(false)} />}
    <button className="project-trigger" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={t("projectMenu")}>
      <span className="brand-mark">RC</span>
      <span className="project-name">
        <strong title={source?.name}>{source?.name ?? "ROUGH/CUT"}</strong>
        <small className={`autosave-state ${source ? autosaveState.tone : ""}`}>{source ? t(autosaveState.key, autosaveState.vars) : t("brandTagline")}</small>
      </span>
      <span className="caret" aria-hidden="true">▾</span>
      {!runtime?.transcriptionReady && <i className="attention" aria-hidden="true" />}
    </button>
    {open && <div className="menu-popover" role="menu">
      {item(t("newProject"), onNew, { shortcut: "⌘N", disabled: operationBusy, icon: "＋" })}
      {item(`${t("openProject")}…`, onOpen, { shortcut: "⌘O", disabled: operationBusy, icon: "↥" })}
      {item(saving ? t("saving") : t("saveProject"), onSave, { shortcut: "⌘S", disabled: !source || operationBusy, icon: "⤓" })}
      {item(t("closeProject"), onClose, { disabled: !source || operationBusy, icon: "×" })}
      <hr/>
      {item(t("setup"), onSetup, { disabled: setupBusy, icon: runtime?.transcriptionReady ? "✓" : "!" })}
      {item(t("storage"), onStorage, { disabled: operationBusy, icon: "▤" })}
      {item(t("logs"), onLogs, { icon: "≡" })}
      <div className="menu-language"><span>{t("language")}</span>
        {[["system", t("languageSystem")], ["ru", "Русский"], ["en", "English"]].map(([value, label]) => <button key={value} role="menuitemradio" aria-checked={preference === value} className={preference === value ? "active" : ""} onClick={() => onLocale(value)}>{label}</button>)}
      </div>
    </div>}
  </div>;
}

function ProjectSwitchDialog({ action, currentName, saving, closing, onCancel, onContinue, onSaveAndContinue }) {
  const openingSavedProject = action === "open";
  const closingProject = action === "close";
  const pending = saving || closing;
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !pending) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, onCancel]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onCancel(); }}>
    <section className="project-switch-modal" role="dialog" aria-modal="true" aria-labelledby="project-switch-title">
      <header><div><span>{closingProject ? t("switchClose") : t("switchSwitch")}</span><h2 id="project-switch-title">{closingProject ? t("switchCloseTitle") : openingSavedProject ? t("switchOpenTitle") : t("switchNewTitle")}</h2></div><button onClick={onCancel} disabled={pending} aria-label={t("close")}>×</button></header>
      <div className="project-switch-copy">
        <strong title={currentName}>{currentName}</strong>
        <p>{closingProject ? t("switchCloseBody") : openingSavedProject ? t("switchOpenBody") : t("switchNewBody")}</p>
        <p>{t("switchSaveHint")}</p>
      </div>
      <footer>
        <button className="secondary" onClick={onCancel} disabled={pending}>{t("cancel")}</button>
        <button className="secondary danger" onClick={onContinue} disabled={pending}>{closing ? t("closing") : closingProject ? t("closeWithoutSaving") : t("continueWithoutSaving")}</button>
        <button className="primary" onClick={onSaveAndContinue} disabled={pending}>{saving ? t("saving") : closingProject ? t("saveAndClose") : t("saveAndContinue")}</button>
      </footer>
    </section>
  </div>;
}

function SetupManager({ runtime, transcriptionModelId, blocking = false, installing, operation, error, onModelChange, onInstall, onCancel, onClose, onShowLogs }) {
  const editingReady = Boolean(runtime?.ffmpeg?.ready && runtime?.ffprobe?.ready);
  const transcriptionReady = Boolean(runtime?.whisper?.ready && runtime?.model?.ready && runtime?.vadModel?.ready);
  const allReady = editingReady && transcriptionReady;
  const sourceText = (items) => items.some((item) => item?.source === "downloaded") ? t("setupInstalled") : items.some((item) => item?.source === "system") ? t("setupSystem") : t("setupBundled");
  const row = (label, ready, items, missingText) => <div className={ready ? "ready" : "missing"}><i>{ready ? "✓" : "↓"}</i><span><strong>{label}</strong><small>{ready ? sourceText(items) : missingText}</small></span></div>;
  return <div className={blocking ? "setup-page" : "modal-backdrop"} role={blocking ? "main" : "presentation"} onMouseDown={(event) => { if (!blocking && event.target === event.currentTarget && !installing) onClose(); }}>
    <section className="setup-card" role={blocking ? undefined : "dialog"} aria-modal={blocking ? undefined : "true"} aria-labelledby="setup-title">
      <header><div><span>{t("setupEyebrow")}</span><h1 id="setup-title">{t("setupTitle")}</h1></div>{!blocking && <button onClick={onClose} disabled={installing} aria-label={t("close")}>×</button>}</header>
      <p>{t("setupBody")}</p>
      <div className="dependency-grid">
        {row(t("setupEditing"), editingReady, [runtime?.ffmpeg, runtime?.ffprobe], t("setupEditingMissing"))}
        {row(t("setupTranscription"), transcriptionReady, [runtime?.whisper, runtime?.model, runtime?.vadModel], t("setupTranscriptionMissing"))}
      </div>
      <label className="model-picker"><span><strong>{t("setupQuality")}</strong><small>{t("setupQualityHint")}</small></span><select value={transcriptionModelId} onChange={(event) => onModelChange(event.target.value)} disabled={installing}>{(runtime?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label} · {model.detail}{model.ready ? ` · ${t("installed")}` : ""}</option>)}</select><small>{runtime?.models?.find((model) => model.id === transcriptionModelId)?.description}</small></label>
      {!runtime?.canInstall && !allReady && <div className="setup-warning"><strong>{t("setupUnavailable")}</strong><span>{t("setupReinstall")}</span></div>}
      {error && <div className="setup-error">{error}</div>}
      {installing && <div className="setup-progress" role="status" aria-live="polite"><div><i style={{ width: `${operation?.percent ?? 4}%` }}/></div><span>{operation?.message ?? t("setupPreparing")}</span></div>}
      <footer><span>{allReady ? t("setupAllReady") : runtime?.canInstall ? t("setupDownload", { size: formatBytes(runtime.installBytes) }) : t("setupAttention")}</span><div className="setup-actions"><button onClick={onShowLogs}>{t("logs")}</button>{installing ? <button className="secondary" onClick={onCancel}>{t("cancel")}</button> : runtime?.canInstall ? <button className="primary" onClick={onInstall}>{error ? t("setupRetry") : t("setupInstall")}</button> : !blocking && <button className="primary" onClick={onClose}>{t("done")}</button>}</div></footer>
    </section>
  </div>;
}

function StorageManager({ sourceId, onClose, onDeleted }) {
  const [storage, setStorage] = useState(null);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [clearArmed, setClearArmed] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try { setStorage(await window.roughcut.listProxies({ sourceId })); }
    catch (loadError) { setError(loadError.message); }
  }, [sourceId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape" && !deleting) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleting, onClose]);
  const remove = async (items) => {
    setDeleting(items.length === 1 ? items[0].id : "all"); setError(null);
    try {
      await window.roughcut.deleteProxies({ ids: items.map((item) => item.id) });
      onDeleted(items);
      setClearArmed(false);
      await load();
    } catch (deleteError) { setError(deleteError.message); }
    finally { setDeleting(null); }
  };
  const clearAll = () => {
    if (!storage?.proxies.length) return;
    if (!clearArmed) { setClearArmed(true); return; }
    remove(storage.proxies);
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) onClose(); }}>
    <section className="storage-modal" role="dialog" aria-modal="true" aria-labelledby="storage-title">
      <header><div><span>{t("storageEyebrow")}</span><h2 id="storage-title">{t("storageTitle")}</h2></div><button onClick={onClose} disabled={Boolean(deleting)} aria-label={t("close")}>×</button></header>
      <div className="storage-summary"><div><span>{t("storageTotal")}</span><strong>{storage?.proxies.length ?? "—"}</strong></div><div><span>{t("storageUsage")}</span><strong>{storage ? formatBytes(storage.totalSize) : "—"}</strong></div><button className={clearArmed ? "armed" : ""} onClick={clearAll} disabled={!storage?.proxies.length || Boolean(deleting)}>{deleting === "all" ? t("storageDeleting") : clearArmed ? t("storageConfirmAll") : t("storageDeleteAll")}</button></div>
      <div className="storage-location"><span>{t("storageLocation")}</span><code>{storage?.cacheLocation ?? t("loading")}</code></div>
      {error && <div className="storage-error">{error}</div>}
      <div className="proxy-list">
        {!storage && !error && <div className="storage-loading"><span className="spinner"/> {t("storageReading")}</div>}
        {storage?.proxies.length === 0 && <div className="storage-empty"><strong>{t("storageEmpty")}</strong><span>{t("storageEmptyHint")}</span></div>}
        {storage?.proxies.map((item, index) => <article className={item.current ? "current" : ""} key={item.id}>
          <div className="proxy-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="proxy-description"><div><strong title={item.sourceName}>{item.sourceName}</strong>{item.current && <i>{t("storageCurrent")}</i>}</div><span>{item.width ? `${item.width}×${item.height}` : t("storageLegacy")} · {formatDuration(item.duration)} · {new Date(item.modifiedAt).toLocaleString()}</span><code>{item.id}</code></div>
          <output>{formatBytes(item.size)}</output>
          <button onClick={() => remove([item])} disabled={Boolean(deleting)}>{deleting === item.id ? <span className="spinner"/> : t("delete")}</button>
        </article>)}
      </div>
      <footer>{t("storageFooter")}</footer>
    </section>
  </div>;
}

// Kept ranges laid end to end: `at` is where each one starts in the edited video.
function editedClips(keeps) {
  let at = 0;
  return keeps.map((keep) => { const clip = { ...keep, at, gapBefore: 0 }; at += keep.end - keep.start; return clip; })
    .map((clip, i, all) => ({ ...clip, gapBefore: i ? clip.start - all[i - 1].end : clip.start }));
}

function Timeline({ media, waveform, keeps, collapsed, decisions, textCandidates, manualOverrides, selection, onSelect, onCreateRemove, onSeek, currentTime, zoom }) {
  const dragRef = useRef(null);
  const scrollRef = useRef(null);
  const scrollFrameRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const clips = useMemo(() => editedClips(keeps), [keeps]);
  const editedDuration = clips.length ? clips.at(-1).at + clips.at(-1).end - clips.at(-1).start : 0;
  // In the collapsed view time runs through the edited video only.
  const span = collapsed ? Math.max(editedDuration, 0.001) : media.duration;
  const [viewport, setViewport] = useState({ start: 0, end: span });
  const toSource = useCallback((value) => {
    if (!collapsed) return value;
    const clip = clips.find((c) => value < c.at + c.end - c.start) ?? clips.at(-1);
    return clip ? Math.min(clip.end, clip.start + Math.max(0, value - clip.at)) : 0;
  }, [collapsed, clips]);
  const toView = useCallback((value) => {
    if (!collapsed) return value;
    const clip = clips.find((c) => value < c.end) ?? clips.at(-1);
    return clip ? clip.at + Math.min(clip.end - clip.start, Math.max(0, value - clip.start)) : 0;
  }, [collapsed, clips]);
  // A short recording fills the panel instead of ending mid-way.
  const width = Math.max(containerWidth || 1000, span * zoom);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setContainerWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rulerStep = zoom >= 16 ? 10 : zoom >= 7 ? 30 : zoom >= 3 ? 60 : 120;
  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const visibleStart = element.scrollLeft / width * span;
    const visibleDuration = element.clientWidth / width * span;
    setViewport({ start: Math.max(0, visibleStart - visibleDuration), end: Math.min(span, visibleStart + visibleDuration * 2) });
  }, [span, width]);
  useEffect(() => {
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [updateViewport]);
  const scheduleViewportUpdate = () => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateViewport();
    });
  };
  const ticks = [];
  for (let second = Math.floor(viewport.start / rulerStep) * rulerStep; second <= viewport.end; second += rulerStep) ticks.push(second);
  const visible = (items) => items.filter((item) => item.end >= viewport.start && item.start <= viewport.end);
  const pointerTime = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(span, (event.clientX - rect.left) / width * span));
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { start: pointerTime(event), moved: false };
  };
  const onPointerMove = (event) => {
    if (!dragRef.current) return;
    const end = pointerTime(event);
    if (Math.abs(end - dragRef.current.start) > Math.max(0.08, span / width * 3)) dragRef.current.moved = true;
    dragRef.current.end = end;
    event.currentTarget.style.setProperty("--drag-start", `${Math.min(dragRef.current.start, end) / span * 100}%`);
    event.currentTarget.style.setProperty("--drag-width", `${Math.abs(end - dragRef.current.start) / span * 100}%`);
    event.currentTarget.dataset.dragging = dragRef.current.moved ? "true" : "false";
  };
  const onPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.dataset.dragging = "false";
    if (!drag) return;
    const end = drag.end ?? drag.start;
    if (drag.moved) onCreateRemove(toSource(Math.min(drag.start, end)), toSource(Math.max(drag.start, end)));
    else onSeek(toSource(drag.start));
  };
  const rangeButton = (item, className, lane) => <button
    type="button"
    key={item.key}
    className={`range ${className} ${selection?.key === item.key ? "selected" : ""}`}
    title={`${candidateLabel(item.reason)} · ${timecode(item.start, media.frameRate)}–${timecode(item.end, media.frameRate)}`}
    aria-label={t("selectRemoval", { label: candidateLabel(item.reason) })}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); onSelect({ ...item, kind: lane }); onSeek(item.start); }}
    style={{ left: `${item.start / span * 100}%`, width: `${(item.end - item.start) / span * 100}%` }}
  />;
  const windowStyle = { left: viewport.start / span * width, width: Math.max(1, (viewport.end - viewport.start) / span * width) };
  const visibleClips = clips.filter((clip) => clip.at + clip.end - clip.start >= viewport.start && clip.at <= viewport.end);

  return <div className="timeline-scroll" ref={scrollRef} onScroll={scheduleViewportUpdate}>
    <div className={`timeline-canvas ${collapsed ? "collapsed" : ""}`} style={{ width }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="drag-ghost" />
      <div className="ruler">{ticks.map((tick) => <div className="tick" key={tick} style={{ left: `${tick / span * 100}%` }}><span>{timecode(tick, media.frameRate).slice(0, 8)}</span></div>)}</div>
      {collapsed ? <div className="track track-video track-edited"><span className="track-label">{t("trackEdited")}</span>
        {visibleClips.map((clip, i) => <div key={`edited-${clip.start}`} className={`edited-clip ${clip.at > 0 ? "has-join" : ""}`} style={{ left: `${clip.at / span * 100}%`, width: `${(clip.end - clip.start) / span * 100}%` }}
          title={`${clockTime(clip.start)}–${clockTime(clip.end)}${clip.at > 0 ? ` · ${t("joinRemoved", { seconds: clip.gapBefore.toFixed(1) })}` : ""}`}>
          <WaveformCanvas waveform={waveform} keeps={[clip]} start={clip.start} end={clip.end} />
        </div>)}
      </div> : <>
        <div className="track track-video"><span className="track-label">{t("trackVideo")}</span>
          {visible(keeps).map((keep) => <i key={`clip-${keep.start}`} className="clip" style={{ left: `${keep.start / span * 100}%`, width: `${(keep.end - keep.start) / span * 100}%` }} />)}
          <WaveformCanvas waveform={waveform} keeps={keeps} start={viewport.start} end={viewport.end} className="track-waveform" style={windowStyle} />
        </div>
        <div className="track track-auto"><span className="track-label">{t("trackSilence")}</span>{visible(decisions).map((item) => rangeButton(item, "auto-range", "automatic"))}</div>
        {textCandidates.length > 0 && <div className="track track-text"><span className="track-label">{t("trackSpeech")}</span>{visible(textCandidates).map((item) => rangeButton(item, `text-range ${item.applied ? "applied" : "suggested"}`, "text"))}</div>}
        <div className="track track-manual"><span className="track-label">{t("trackManual")}</span>{visible(manualOverrides).map((item) => rangeButton({ ...item, key: `manual:${item.id}`, reason: item.action, start: item.start, end: item.end }, `manual-range ${item.action}`, "manual"))}</div>
      </>}
      <div className="playhead" style={{ left: `${toView(currentTime) / span * 100}%` }}><span /></div>
    </div>
  </div>;
}

function AnalysisProgress({ stages, operation }) {
  const current = stages.indexOf(operation?.stage);
  return <ol className="stage-list">
    {stages.map((stage, i) => {
      const state = current < 0 ? (i === 0 ? "active" : "pending") : i < current ? "done" : i === current ? "active" : "pending";
      const percent = state === "active" && operation?.percent != null && stage === "transcribe" ? ` ${operation.percent}%` : "";
      return <li key={stage} className={state}><i aria-hidden="true">{state === "done" ? "✓" : i + 1}</i>{t("stages")[stage]}{percent}</li>;
    })}
  </ol>;
}

function App() {
  // Two players take turns: while one plays, the other waits paused and muted
  // at the start of the next kept part, so a cut is a switch instead of a seek
  // (a seek restarts Chromium's audio and is heard as a short gap).
  // videoRef always points at the player that is currently on screen.
  const videoRef = useRef(null);
  const playerEls = useRef([null, null]);
  const activeIndex = useRef(0);
  const [activePlayer, setActivePlayer] = useState(0);
  const playerRefs = useMemo(() => [0, 1].map((index) => (element) => {
    playerEls.current[index] = element;
    if (!element) return;
    element.muted = index !== activeIndex.current;
    if (index === activeIndex.current) videoRef.current = element;
  }), []);
  const roughSeekRef = useRef(false);
  // A range played from the review: { end, edited }. Raw ranges ignore cuts so
  // a removed take can be heard; edited ranges skip cuts like the final video.
  const reviewRef = useRef(null);
  const [, setLocaleVersion] = useState(0);
  const [source, setSource] = useState(null);
  const [sessionPath, setSessionPath] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [analysis, setAnalysis] = useState(EMPTY_ANALYSIS);
  const [analysisSignature, setAnalysisSignature] = useState(null);
  const [manualOverrides, setManualOverrides] = useState([]);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [selection, setSelection] = useState(null);
  const [projectResolution, setProjectResolution] = useState("source");
  const [exportFormat, setExportFormat] = useState("final-cut");
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [removeNonVerbal, setRemoveNonVerbal] = useState(true);
  const [textConfidence, setTextConfidence] = useState(0.9);
  const [duplicateMode, setDuplicateMode] = useState(DEFAULT_DUPLICATE_MODE);
  const [transcriptionModelId, setTranscriptionModelId] = useState(() => typeof window === "undefined"
    ? DEFAULT_TRANSCRIPTION_MODEL_ID
    : normalizeTranscriptionModelId(window.localStorage.getItem(TRANSCRIPTION_MODEL_STORAGE_KEY)));
  const [zoom, setZoom] = useState(2);
  const [editorMode, setEditorMode] = useState("text");
  const [currentTime, setCurrentTime] = useState(0);
  const [preview, setPreview] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closingProject, setClosingProject] = useState(false);
  const [openingVideo, setOpeningVideo] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [runtime, setRuntime] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupError, setSetupError] = useState(null);
  const [autosaveState, setAutosaveState] = useState({ tone: "idle", key: "recoveryIdle" });
  const [status, setStatus] = useState({ tone: "idle", text: t("chooseRecording") });
  const [operation, setOperation] = useState(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [projectSwitchAction, setProjectSwitchAction] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [playbackError, setPlaybackError] = useState(null);
  const [waveform, setWaveform] = useState(null);
  const [timelineView, setTimelineView] = useState(() => { try { return window.localStorage.getItem(TIMELINE_VIEW_KEY) === "edited" ? "edited" : "source"; } catch { return "source"; } });
  const chooseTimelineView = (view) => { setTimelineView(view); try { window.localStorage.setItem(TIMELINE_VIEW_KEY, view); } catch {} };
  const media = source?.media;
  const operationBusy = busy || proxyBusy || setupBusy || saving || closingProject || openingVideo;
  const transcriptionReady = Boolean(runtime?.transcriptionReady);
  // Speech options only take effect once the speech model is installed.
  const effectiveTranscript = includeTranscript && transcriptionReady;
  const effectiveNonVerbal = removeNonVerbal && transcriptionReady;
  const analysisInput = useMemo(() => ({ settings, includeTranscript: effectiveTranscript, removeNonVerbal: effectiveNonVerbal, textConfidence, transcriptionModelId, duplicateMode }), [settings, effectiveTranscript, effectiveNonVerbal, textConfidence, transcriptionModelId, duplicateMode]);
  const hasTranscript = analysis.transcript?.segments?.length > 0;
  const textMode = editorMode === "text" && hasTranscript;
  const analysisCurrent = analysisIsCurrent(analysisSignature, analysisInput);
  const analysisStale = Boolean(analysisSignature) && !analysisCurrent;

  const silenceDecisions = useMemo(() => (analysis.silenceRemovals?.length ? analysis.silenceRemovals : analysis.automaticRemovals ?? []).map((range, index) => ({ key: `silence:${index}`, reason: "silence", start: framesToSeconds(range.startFrame, media.frameRate), end: framesToSeconds(range.endFrame, media.frameRate), applied: true })), [analysis, media]);
  const textDecisions = useMemo(() => (analysis.textCandidates ?? []).map((item, index) => ({ ...item, key: `text:${item.id ?? index}` })), [analysis.textCandidates]);
  const finalPlan = useMemo(() => {
    if (!media) return { removals: [], keeps: [], durationFrames: 0 };
    // The same plan function the desktop export and the CLI use.
    return buildPlan({ ...analysis, media, settings: { keepPause: settings.keepPause } }, manualOverrides);
  }, [analysis, manualOverrides, media, settings.keepPause]);
  const keepSeconds = useMemo(() => media ? finalPlan.keeps.map((keep) => ({ start: framesToSeconds(keep.startFrame, media.frameRate), end: framesToSeconds(keep.endFrame, media.frameRate) })) : [], [finalPlan, media]);
  const currentWaveform = waveform && waveform.sourceId === source?.sourceId ? waveform.data : null;

  const progressText = (update) => {
    if (update.phase === "error" || update.phase === "cancelled") return update.message;
    if (update.operation === "analysis" && update.stage) return `${t("stageRunning")[update.stage]}${update.stage === "transcribe" && update.percent != null ? ` ${update.percent}%` : ""}`;
    if (update.operation === "preview" && update.phase === "running" && update.percent != null) return t("buildingProxy", { percent: update.percent });
    if (update.operation === "export" && update.stage === "render" && update.phase === "running") return t("renderingButton", { percent: update.percent ?? 0 });
    return update.message;
  };
  useEffect(() => window.roughcut.onProgress((update) => {
    setOperation(update);
    setStatus({ tone: update.phase === "error" ? "error" : update.phase === "done" ? "success" : update.phase === "cancelled" ? "idle" : "working", text: progressText(update) });
  }), []);

  const buildPreview = useCallback(async (nextSource) => {
    setProxyBusy(true); setPreviewError(null); setPlaybackError(null); setOperation({ operation: "preview", phase: "running", message: t("preparingPlayback"), percent: 0 });
    try {
      const result = await window.roughcut.preparePreview({ sourceId: nextSource.sourceId });
      setSource((current) => current?.sourceId === nextSource.sourceId ? { ...current, previewUrl: result.previewUrl } : current);
    } catch (error) {
      if (/cancelled/i.test(error.message)) setStatus({ tone: "idle", text: t("previewCancelled") });
      else { setPreviewError(error.message); setStatus({ tone: "error", text: t("previewFailedStatus", { error: error.message }) }); }
    } finally { setProxyBusy(false); }
  }, []);

  // The waveform is read in the background and never blocks other work.
  useEffect(() => {
    const sourceId = source?.sourceId;
    if (!sourceId || typeof window.roughcut.waveform !== "function") return undefined;
    let alive = true;
    window.roughcut.waveform({ sourceId }).then((data) => { if (alive && data?.peaks) setWaveform({ sourceId, data }); }).catch(() => {});
    return () => { alive = false; };
  }, [source?.sourceId]);

  // A new proxy starts on the first player.
  useEffect(() => {
    activeIndex.current = 0;
    setActivePlayer(0);
    videoRef.current = playerEls.current[0];
  }, [source?.previewUrl]);

  useEffect(() => {
    const players = playerEls.current;
    if (!media || !players[0] || !players[1] || typeof players[0].requestVideoFrameCallback !== "function") return undefined;
    const frame = media.frameRate.denominator / media.frameRate.numerator;
    const jumps = playbackJumps(finalPlan.removals, media.frameRate, media.duration);
    const handles = [null, null];
    let switchTimer = null;
    const skipping = () => (reviewRef.current ? reviewRef.current.edited : preview);
    const prepare = (standby, jump) => {
      if (standby.dataset.target === String(jump.end)) return;
      standby.dataset.target = String(jump.end);
      standby.pause();
      standby.muted = true;
      standby.currentTime = jump.end;
    };
    const ready = (standby, jump) => standby.dataset.target === String(jump.end) && !standby.seeking && standby.readyState >= 3;
    const seekPast = (player, jump) => {
      if (player.seeking || roughSeekRef.current) return;
      roughSeekRef.current = true;
      player.currentTime = jump.end;
      setCurrentTime(jump.end);
      player.addEventListener("seeked", () => { roughSeekRef.current = false; }, { once: true });
    };
    const switchAt = (index, jump) => {
      switchTimer = null;
      const from = players[index], to = players[1 - index];
      if (activeIndex.current !== index || from.paused || !skipping()) return;
      if (!ready(to, jump)) { seekPast(from, jump); return; }
      activeIndex.current = 1 - index;
      videoRef.current = to;
      to.muted = false;
      to.classList.add("active");
      from.classList.remove("active");
      to.play().catch(() => seekPast(from, jump));
      from.pause();
      from.muted = true;
      from.dataset.target = "";
      setActivePlayer(1 - index);
      setCurrentTime(to.currentTime);
    };
    const follow = (index) => (_now, metadata) => {
      const player = players[index];
      if (index === activeIndex.current && !player.paused && skipping()) {
        const time = metadata.mediaTime;
        const jump = upcomingJump(jumps, time);
        if (jump && time >= jump.start) {
          // Already inside a cut: playback started there, or the switch was late.
          if (!switchTimer) seekPast(player, jump);
        } else if (jump && jump.start - time <= frame * 3) {
          // Switch exactly when the kept part ends, not on the next frame.
          if (!switchTimer) switchTimer = setTimeout(() => switchAt(index, jump), Math.max(0, (jump.start - player.currentTime) * 1000 / (player.playbackRate || 1)));
        } else if (jump) prepare(players[1 - index], jump);
      }
      handles[index] = player.requestVideoFrameCallback(follow(index));
    };
    handles[0] = players[0].requestVideoFrameCallback(follow(0));
    handles[1] = players[1].requestVideoFrameCallback(follow(1));
    return () => {
      players.forEach((player, index) => { if (handles[index] != null) player.cancelVideoFrameCallback(handles[index]); player.dataset.target = ""; });
      if (switchTimer) clearTimeout(switchTimer);
    };
  }, [media, preview, finalPlan.removals, source?.previewUrl]);

  const replaceOverrides = useCallback((next) => { setPast((items) => [...items.slice(-49), manualOverrides]); setFuture([]); setManualOverrides(next); }, [manualOverrides]);
  const undo = useCallback(() => { if (!past.length) return; setFuture((items) => [manualOverrides, ...items]); setManualOverrides(past.at(-1)); setPast((items) => items.slice(0, -1)); setSelection(null); }, [past, manualOverrides]);
  const redo = useCallback(() => { if (!future.length) return; setPast((items) => [...items, manualOverrides]); setManualOverrides(future[0]); setFuture((items) => items.slice(1)); setSelection(null); }, [future, manualOverrides]);
  const selectedManual = selection?.kind === "manual" ? manualOverrides.find((item) => `manual:${item.id}` === selection.key) : null;
  const clearSelectedOverride = useCallback(() => {
    if (!selectedManual) return;
    replaceOverrides(manualOverrides.filter((item) => item.id !== selectedManual.id)); setSelection(null);
  }, [selectedManual, manualOverrides, replaceOverrides]);
  const setSelectedAction = (action) => {
    if (!selectedManual) return;
    replaceOverrides(manualOverrides.map((item) => item.id === selectedManual.id ? { ...item, action } : item));
  };
  const createOverride = (action, start, end, originKey = null) => {
    const sameTiming = (item) => Math.abs(item.start - start) < 0.001 && Math.abs(item.end - end) < 0.001;
    const existing = manualOverrides.find((item) => (item.originKey === originKey && originKey) || (originKey && sameTiming(item)));
    if (existing) {
      replaceOverrides(manualOverrides.map((item) => item.id === existing.id ? { ...item, action, start, end } : item));
      setSelection({ kind: "manual", key: `manual:${existing.id}` });
      return;
    }
    const item = { id: crypto.randomUUID(), action, start, end, originKey };
    replaceOverrides([...manualOverrides, item]); setSelection({ kind: "manual", key: `manual:${item.id}` });
  };
  const useAutomaticDecision = () => {
    if (!selection || selection.kind === "manual") return;
    replaceOverrides(manualOverrides.filter((item) => item.originKey !== selection.key && !(Math.abs(item.start - selection.start) < 0.001 && Math.abs(item.end - selection.end) < 0.001)));
  };
  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !source?.previewUrl) return;
    if (video.paused) video.play().catch(() => setPlaybackError(t("playbackErrors").start)); else video.pause();
  }, [source?.previewUrl]);

  useEffect(() => {
    const onKey = (event) => {
      const editable = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (!editable && event.code === "Space") { event.preventDefault(); togglePlayback(); }
      else if (textMode || editable || !selectedManual) return; // text review has its own keys
      else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); clearSelectedOverride(); }
      else if (event.key.toLowerCase() === "r") setSelectedAction("remove");
      else if (event.key.toLowerCase() === "k") setSelectedAction("keep");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, togglePlayback, clearSelectedOverride, selectedManual, textMode]);

  const applyDefaults = () => {
    setSettings(DEFAULT_SETTINGS); setProjectResolution("source"); setExportFormat("final-cut"); setIncludeTranscript(true); setRemoveNonVerbal(true); setTextConfidence(0.9); setDuplicateMode(DEFAULT_DUPLICATE_MODE);
  };
  const installSource = useCallback((next, loaded = null) => {
    videoRef.current?.pause();
    setSource({ ...next, previewUrl: null }); setAnalysis(loaded?.analysis ?? EMPTY_ANALYSIS); setManualOverrides(loaded?.manualOverrides ?? []);
    setSessionPath(loaded?.sessionPath ?? null); setAnalysisSignature(loaded?.analysisSignature ?? null);
    setPast([]); setFuture([]); setSelection(null); setCurrentTime(0); setPreview(true); setPlaying(false); setZoom(2); setPreviewError(null); setPlaybackError(null); roughSeekRef.current = false; reviewRef.current = null;
    if (loaded) {
      setSettings(loaded.settings); setProjectResolution(loaded.projectResolution ?? "source"); setExportFormat(loaded.exportFormat ?? "final-cut");
      setIncludeTranscript(loaded.includeTranscript === true); setRemoveNonVerbal(loaded.removeNonVerbal === true); setTextConfidence(loaded.textConfidence ?? 0.9); setDuplicateMode(loaded.duplicateMode ?? "rules");
    } else applyDefaults();
    buildPreview(next);
  }, [buildPreview]);

  const resetProject = useCallback(() => {
    videoRef.current?.pause();
    setSource(null); setSessionPath(null); setAnalysis(EMPTY_ANALYSIS); setAnalysisSignature(null); setManualOverrides([]);
    setPast([]); setFuture([]); setSelection(null); applyDefaults();
    setZoom(2); setCurrentTime(0); setPreview(true); setPlaying(false); setOperation(null); setStorageOpen(false); setPreviewError(null); setPlaybackError(null); roughSeekRef.current = false; reviewRef.current = null;
    setAutosaveState({ tone: "idle", key: "recoveryIdle" });
  }, []);

  useEffect(() => {
    let alive = true;
    const bootstrap = async () => {
      try {
        const nextRuntime = await window.roughcut.runtimeStatus({ transcriptionModelId });
        if (!alive) return;
        setRuntime(nextRuntime);
        if (!nextRuntime.coreReady || !nextRuntime.transcriptionReady) setSetupOpen(true);
        if (!nextRuntime.coreReady) return;
        const recovered = await window.roughcut.recoverSession();
        if (!alive || !recovered) return;
        installSource(recovered, recovered);
        setStatus({ tone: "success", text: recovered.sessionPath ? t("sessionRestored") : t("autosaveRecovered") });
      } catch (error) {
        if (alive) setStatus({ tone: "error", text: t("recoveryUnavailable", { error: error.message }) });
      } finally {
        if (alive) setBooting(false);
      }
    };
    bootstrap();
    return () => { alive = false; };
  }, [installSource]);

  const sessionPayload = useMemo(() => source ? {
    sourceId: source.sourceId,
    sessionPath,
    settings,
    projectResolution,
    exportFormat,
    includeTranscript,
    removeNonVerbal,
    textConfidence,
    duplicateMode,
    transcriptionModelId,
    analysisSignature,
    analysis,
    manualOverrides,
  } : null, [source?.sourceId, sessionPath, settings, projectResolution, exportFormat, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId, duplicateMode, analysisSignature, analysis, manualOverrides]);

  useEffect(() => {
    if (booting || !sessionPayload) return undefined;
    setAutosaveState({ tone: "working", key: "recoverySaving" });
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.roughcut.autosaveSession(sessionPayload);
        setAutosaveState({ tone: "success", key: "recoverySaved", vars: { time: new Date(result.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) } });
      } catch (error) {
        setAutosaveState({ tone: "error", key: "recoveryFailed", vars: { error: error.message } });
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [booting, sessionPayload]);

  useEffect(() => window.roughcut.onSessionFlushRequest(async () => {
    try {
      if (sessionPayload) await window.roughcut.autosaveSession(sessionPayload);
    } finally {
      window.roughcut.finishSessionFlush();
    }
  }), [sessionPayload]);
  const chooseVideo = async () => {
    if (operationBusy) return false;
    setOpeningVideo(true);
    setStatus({ tone: "working", text: t("chooseVideo") });
    try {
      const next = await window.roughcut.chooseVideo();
      if (!next) { setStatus({ tone: "idle", text: t("chooseRecording") }); return false; }
      installSource(next); setStatus({ tone: "working", text: t("newProjectCreated") });
      return true;
    } catch (error) { setStatus({ tone: "error", text: error.message }); return false; }
    finally { setOpeningVideo(false); }
  };
  const showLogs = async () => {
    try { await window.roughcut.showLogs(); }
    catch (error) { setStatus({ tone: "error", text: t("logsFailed", { error: error.message }) }); }
  };
  const analysisBlocked = proxyBusy || setupBusy;
  const analyze = async () => {
    if (!source || operationBusy || analysisBlocked) return;
    const nextSignature = analysisFingerprint(analysisInput);
    setBusy(true); setOperation({ operation: "analysis", phase: "running", stage: "silence", message: t("stageRunning").silence, percent: null });
    try {
      const result = await window.roughcut.analyze({ sourceId: source.sourceId, ...analysisInput });
      setAnalysis(result); setAnalysisSignature(nextSignature); setSelection(null);
      const suggestions = result.textCandidates?.filter((item) => !item.applied).length ?? 0;
      setStatus({ tone: result.textEditSummary?.verificationFailures ? "idle" : "success", text: `${t("analysisDone", { cuts: result.automaticRemovals.length, suggestions })}${result.textEditSummary?.verificationFailures ? t("analysisPartial") : ""}` });
      if (result.transcript?.segments?.length) setEditorMode("text");
    } catch (error) { const cancelled = /cancelled/i.test(error.message); setStatus({ tone: cancelled ? "idle" : "error", text: cancelled ? t("analysisCancelled") : error.message }); }
    finally { setBusy(false); setOperation(null); }
  };
  const saveSession = async () => {
    if (!sessionPayload || saving) return false;
    setSaving(true);
    try {
      const saved = await window.roughcut.saveSession(sessionPayload);
      if (!saved) return false;
      setSessionPath(saved.path); setStatus({ tone: "success", text: t("savedAs", { name: saved.path.split(/[\\/]/).at(-1) }) });
      return true;
    }
    catch (error) { setStatus({ tone: "error", text: error.message }); return false; }
    finally { setSaving(false); }
  };
  const loadSession = async () => {
    if (operationBusy) return false;
    try {
      const loaded = await window.roughcut.loadSession();
      if (!loaded) return false;
      installSource(loaded, loaded); setStatus({ tone: "working", text: t("projectOpened") });
      return true;
    }
    catch (error) { setStatus({ tone: "error", text: error.message }); return false; }
  };
  const closeProject = async () => {
    if (!source || operationBusy) return false;
    setClosingProject(true);
    let closeError = null;
    try { await window.roughcut.closeSession({ sourceId: source.sourceId }); }
    catch (error) { closeError = error; }
    resetProject();
    setProjectSwitchAction(null);
    setStatus(closeError
      ? { tone: "error", text: t("closedWithError", { error: closeError.message }) }
      : { tone: "idle", text: t("chooseRecording") });
    setClosingProject(false);
    return !closeError;
  };
  const performProjectSwitch = async (action) => action === "open" ? loadSession() : action === "close" ? closeProject() : chooseVideo();
  const requestProjectSwitch = (action) => {
    if (operationBusy) return;
    if (source) setProjectSwitchAction(action);
    else performProjectSwitch(action);
  };
  const continueProjectSwitch = async ({ saveFirst = false } = {}) => {
    const action = projectSwitchAction;
    if (!action) return;
    if (saveFirst && !await saveSession()) return;
    if (action !== "close") setProjectSwitchAction(null);
    await performProjectSwitch(action);
  };

  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "n") { event.preventDefault(); requestProjectSwitch("new"); }
      else if (key === "o") { event.preventDefault(); requestProjectSwitch("open"); }
      else if (key === "s" && source) { event.preventDefault(); saveSession(); }
      else if (key === "1" && hasTranscript) { event.preventDefault(); setEditorMode("text"); }
      else if (key === "2" && source) { event.preventDefault(); setEditorMode("timeline"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const exportProject = async () => {
    if (!source || operationBusy || !analysisCurrent) return;
    setBusy(true);
    try { const result = await window.roughcut.exportProject({ sourceId: source.sourceId, ...analysisInput, analysisSignature, projectResolution, exportFormat, analysis, automaticRemovals: analysis.automaticRemovals, manualOverrides }); if (result) setStatus({ tone: "success", text: result.rendered ? t("rendered", { name: result.path.split(/[\\/]/).at(-1), duration: clockTime(result.durationSeconds) }) : t("exported", { label: result.label, ranges: result.keptRanges, note: result.importNote }) }); }
    catch (error) { const cancelled = /cancelled|abort/i.test(error.message); setStatus({ tone: cancelled ? "idle" : "error", text: cancelled ? t("renderCancelled") : error.message }); }
    finally { setBusy(false); setOperation(null); }
  };
  const cancelOperation = async () => { await window.roughcut.cancelOperation(); };
  const chooseTranscriptionModel = async (modelId) => {
    const normalized = normalizeTranscriptionModelId(modelId);
    setTranscriptionModelId(normalized);
    window.localStorage.setItem(TRANSCRIPTION_MODEL_STORAGE_KEY, normalized);
    setSetupError(null);
    try { setRuntime(await window.roughcut.runtimeStatus({ transcriptionModelId: normalized })); }
    catch (error) { setSetupError(error.message); }
  };
  const prepareOpenRoughCut = async () => {
    setSetupBusy(true); setSetupError(null);
    try { const next = await window.roughcut.installDependencies({ transcriptionModelId }); setRuntime(next); if (next.coreReady && next.transcriptionReady) setSetupOpen(false); }
    catch (error) { if (!/cancelled/i.test(error.message)) setSetupError(error.message); }
    finally { setSetupBusy(false); }
  };
  const reviewBatch = (ranges) => {
    replaceOverrides([...manualOverrides, ...ranges.map(range => ({ ...range, id: crypto.randomUUID(), originKey: "transcript-review" }))]);
  };
  const playReview = (start, end, { edited = false } = {}) => {
    reviewRef.current = { end, edited };
    setPlaybackError(null);
    if (videoRef.current) { videoRef.current.currentTime = start; videoRef.current.play().catch(() => setPlaybackError(t("playbackErrors").start)); }
    setCurrentTime(start);
  };
  const seek = (seconds) => { reviewRef.current = null; if (videoRef.current) videoRef.current.currentTime = seconds; setCurrentTime(seconds); };
  const onTimeUpdate = (event) => {
    const video = videoRef.current;
    if (!video || event.currentTarget !== video) return;
    setCurrentTime(video.currentTime);
    if (reviewRef.current && video.currentTime >= reviewRef.current.end) { video.pause(); reviewRef.current = null; }
  };
  const onVideoError = (event) => {
    const code = event.currentTarget.error?.code;
    roughSeekRef.current = false;
    reviewRef.current = null;
    setPlaybackError(t("playbackErrors")[code] ?? t("playbackErrors").unknown);
  };
  const reloadPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    const resumeAt = Math.min(currentTime, media.duration);
    setPlaybackError(null); roughSeekRef.current = false; reviewRef.current = null;
    video.addEventListener("loadedmetadata", () => { video.currentTime = resumeAt; }, { once: true });
    playerEls.current.forEach((player) => { if (player) { player.dataset.target = ""; player.load(); } });
  };
  const onProxiesDeleted = (items) => {
    if (!items.some((item) => item.current)) return;
    playerEls.current.forEach((player) => player?.pause());
    setSource((current) => current ? { ...current, previewUrl: null } : current);
    setPreviewError(null); setPlaybackError(null); setPlaying(false);
    setStatus({ tone: "idle", text: t("proxyDeleted") });
  };
  const changeLocale = (value) => { setLocalePreference(value); setLocaleVersion((version) => version + 1); };
  const selectDecision = (item) => setSelection(item);
  const removed = media ? removedSeconds(finalPlan.removals, media.frameRate) : 0;
  const timelineSize = source ? resolveProjectResolution(source.media, projectResolution) : null;
  const selectedExport = EXPORT_FORMATS.find((item) => item.value === exportFormat) ?? EXPORT_FORMATS[0];
  const pacing = pacingOf(settings);
  const strength = strengthOf(textConfidence);
  const stages = ["silence", ...(effectiveTranscript || effectiveNonVerbal ? ["transcribe"] : []), ...(effectiveTranscript ? ["takes"] : []), ...(effectiveNonVerbal ? ["sounds"] : [])];
  const analysisOperation = operation?.operation === "analysis" ? operation : null;
  const rendering = busy && operation?.operation === "export" && operation.stage === "render";

  if (booting) return <main className="app-shell boot-shell"><section className="boot-splash"><span className="brand-mark">ORC</span><strong>OpenRoughCut</strong><small>…</small><span className="spinner large"/></section></main>;

  const resultBlock = media && <div className="result-meter">
    <span>{t("finalLength")}</span>
    {analysisSignature ? <>
      <strong>{clockTime(media.duration - removed)}</strong>
      <small>{t("ofOriginal", { total: clockTime(media.duration), percent: Math.round(removed / media.duration * 100) })}</small>
      <small>{t("removedParts", { count: finalPlan.removals.length })}{manualOverrides.length ? ` · ${t("manualEdits", { count: manualOverrides.length })}` : ""}</small>
    </> : <strong className="muted">{t("notAnalysed")}</strong>}
  </div>;


  const inspector = source && <aside className="inspector panel"><div className="panel-heading"><span>{t("analysis")}</span><span className={`status-lamp ${status.tone}`}/></div>
    <div className="inspector-body">
    <div className="source-meta"><strong title={source.name}>{source.name}</strong><dl><div><dt>{t("sourceResolution")}</dt><dd>{media.width}×{media.height}</dd></div><div><dt>{t("frameRate")}</dt><dd>{(media.frameRate.numerator / media.frameRate.denominator).toFixed(2)} fps</dd></div><div><dt>{t("duration")}</dt><dd>{clockTime(media.duration)}</dd></div></dl></div>
    <fieldset className="control-stack" disabled={operationBusy}>
      <div className="control-group"><span className="control-title">{t("pacing")}</span>
        <Segmented label={t("pacing")} value={pacing} onChange={(key) => setSettings({ ...settings, ...PACING_PRESETS[key] })} options={[
          { value: "tight", label: t("pacingTight"), hint: t("pacingTightHint") },
          { value: "normal", label: t("pacingNormal"), hint: t("pacingNormalHint") },
          { value: "relaxed", label: t("pacingRelaxed"), hint: t("pacingRelaxedHint") },
        ]}/>
        <small>{pacing === "custom" ? `${t("pacingCustom")} · ${settings.minimumSilence.toFixed(2)} s / ${settings.keepPause.toFixed(2)} s` : t("pacingHint")}</small>
      </div>
      <div className="toggle-group">
        <label className="switch-row" title={transcriptionReady ? t("removeRetakesHint", { model: runtime.model?.label ?? "Whisper" }) : undefined}><input type="checkbox" checked={effectiveTranscript} onChange={(e) => setIncludeTranscript(e.target.checked)} disabled={!transcriptionReady}/><span><b>{t("removeRetakes")}</b>{!transcriptionReady && <small>{t("removeRetakesSetup")}</small>}</span></label>
        {!transcriptionReady && <button type="button" className="setup-link" onClick={() => setSetupOpen(true)}>{t("openSetup")}</button>}
        {effectiveTranscript && <div className="control-group nested"><span className="control-title">{t("strength")}</span>
          <Segmented label={t("strength")} value={strength} onChange={(key) => setTextConfidence(STRENGTHS[key])} options={[
            { value: "careful", label: t("strengthCareful") }, { value: "balanced", label: t("strengthBalanced") }, { value: "bold", label: t("strengthBold") },
          ]}/>
          <small>{t("strengthHint")}</small>
        </div>}
        <label className="switch-row" title={t("removeSoundsHint")}><input type="checkbox" checked={effectiveNonVerbal} onChange={(e) => setRemoveNonVerbal(e.target.checked)} disabled={!transcriptionReady}/><span><b>{t("removeSounds")}</b></span></label>
      </div>
      <details className="fine-tune"><summary>{t("fineTune")}</summary>
        <label><span>{t("silenceThreshold")} <b>{settings.thresholdDb} dB</b></span><small>{t("silenceThresholdHint")}</small><input type="range" min="-60" max="-15" step="1" value={settings.thresholdDb} onChange={(e) => setSettings({ ...settings, thresholdDb: Number(e.target.value) })}/></label>
        <label><span>{t("minimumSilence")} <b>{settings.minimumSilence.toFixed(2)} s</b></span><input type="range" min="0.2" max="3" step="0.05" value={settings.minimumSilence} onChange={(e) => { const minimumSilence = Number(e.target.value); setSettings({ ...settings, minimumSilence, keepPause: Math.min(settings.keepPause, Math.max(0, minimumSilence - 0.05)) }); }}/></label>
        <label><span>{t("pauseToKeep")} <b>{settings.keepPause.toFixed(2)} s</b></span><input type="range" min="0" max={Math.max(0.05, settings.minimumSilence - 0.05)} step="0.01" value={Math.min(settings.keepPause, settings.minimumSilence - 0.05)} onChange={(e) => setSettings({ ...settings, keepPause: Number(e.target.value) })}/></label>
        {effectiveTranscript && <label className="select-label"><span>{t("detector")}</span><select value={duplicateMode} onChange={(event) => setDuplicateMode(event.target.value)}><option value="last-take">{t("detectorLastTake")}</option><option value="rules">{t("detectorRules")}</option></select><small>{duplicateMode === "last-take" ? t("detectorLastTakeHint") : ""}</small></label>}
        {effectiveTranscript && <label><span>{t("exactConfidence")} <b>{Math.round(textConfidence * 100)}%</b></span><input type="range" min="0.7" max="0.99" step="0.01" value={textConfidence} onChange={(e) => setTextConfidence(Number(e.target.value))}/></label>}
      </details>
    </fieldset>
    {analysisStale && <div className="analysis-warning"><strong>{t("staleTitle")}</strong><span>{t("staleBody")}</span></div>}
    {!analysisSignature && <div className="analysis-notice">{t("notice")}</div>}
    </div>
    <div className="inspector-footer">
    <ToolButton className={`analyze-button ${busy && analysisOperation ? "cancel" : ""} ${analysisStale ? "stale" : ""}`} onClick={busy && analysisOperation ? cancelOperation : analyze} disabled={!(busy && analysisOperation) && (operationBusy || analysisBlocked)}>{busy && analysisOperation ? <>{t("cancelAnalysis")}</> : <>{analysisSignature ? t("reanalyse") : t("analyse")} <Icon>↻</Icon></>}</ToolButton>
    <div className={`status-line ${status.tone}`} role="status" aria-live="polite">{analysisOperation ? <AnalysisProgress stages={stages} operation={analysisOperation}/> : <span>{status.text}</span>}{busy && <i className="indeterminate"/>}</div>
    </div>
  </aside>;

  return <main className={`app-shell ${textMode ? "review-shell" : ""}`}>
    <header className="topbar">
      <ProjectMenu source={source} autosaveState={autosaveState} runtime={runtime} saving={saving} setupBusy={setupBusy} operationBusy={operationBusy}
        onNew={() => requestProjectSwitch("new")} onOpen={() => requestProjectSwitch("open")} onSave={saveSession} onClose={() => requestProjectSwitch("close")}
        onSetup={() => setSetupOpen(true)} onLogs={showLogs} onStorage={() => setStorageOpen(true)} onLocale={changeLocale}/>
      {source && runtime?.coreReady && <div className="mode-switch" role="tablist" aria-label={t("editorMode")}>
        <button role="tab" aria-selected={textMode} className={textMode ? "active" : ""} disabled={!hasTranscript} onClick={() => setEditorMode("text")} title={hasTranscript ? `${t("modeText")} (⌘1)` : t("modeTextNeedsAnalysis")}><Icon>¶</Icon>{t("modeText")}</button>
        <button role="tab" aria-selected={!textMode} className={!textMode ? "active" : ""} onClick={() => setEditorMode("timeline")} title={`${t("modeTimeline")} (⌘2)`}><Icon>▤</Icon>{t("modeTimeline")}</button>
      </div>}
      {runtime?.coreReady && source && <div className="top-actions">
        {!analysisCurrent && <button className="export-hint" onClick={analyze} disabled={operationBusy || analysisBlocked}>{analysisStale ? t("exportStale") : t("exportNeedsAnalysis")} ↻</button>}
        <div className="export-group">
          <ExportMenu value={exportFormat} onChange={setExportFormat} disabled={operationBusy} media={media} resolution={projectResolution} onResolution={setProjectResolution}/>
          {rendering ? <ToolButton className="primary rendering" onClick={cancelOperation} title={t("cancel")} style={{ "--render-progress": `${operation.percent ?? 0}%` }}><span className="spinner"/> {t("renderingButton", { percent: operation.percent ?? 0 })}</ToolButton>
            : <ToolButton className="primary" onClick={exportProject} disabled={operationBusy || !analysisCurrent}><Icon>↗</Icon> {t("exportShort")}</ToolButton>}
        </div>
      </div>}
    </header>
    {!runtime?.coreReady ? <SetupManager runtime={runtime} transcriptionModelId={transcriptionModelId} blocking installing={setupBusy} operation={operation} error={setupError} onModelChange={chooseTranscriptionModel} onInstall={prepareOpenRoughCut} onCancel={cancelOperation} onClose={() => {}} onShowLogs={showLogs}/> : !source ? <section className="empty-state"><p className="eyebrow">{t("emptyEyebrow")}</p><h1>{t("emptyTitleA")}<br/><em>{t("emptyTitleB")}</em></h1><p>{t("emptyBody")}</p><div className="empty-actions"><ToolButton className="hero-button" onClick={() => requestProjectSwitch("new")} disabled={openingVideo}>{openingVideo ? t("inspectingVideo") : t("createProject")} <Icon>{openingVideo ? "…" : "→"}</Icon></ToolButton><button className="open-project-link" onClick={() => requestProjectSwitch("open")} disabled={openingVideo}>{t("openSaved")}</button></div>{(openingVideo || status.tone === "error") && <div className={`empty-open-status ${status.tone}`} role="status" aria-live="polite"><div><strong>{openingVideo ? t("inspecting") : t("couldNotOpen")}</strong><span>{status.text}</span></div>{status.tone === "error" && <button onClick={showLogs}>{t("showLog").toUpperCase()}</button>}</div>}<div className="format-note">MOV · MP4 · M4V · MKV · WEBM <span>Final Cut Pro · Premiere Pro · Resolve</span></div></section> :
      <div className={`workspace ${textMode ? "text-workspace" : ""}`}>
        {textMode && <TranscriptReview key={source.sourceId} transcript={analysis.transcript} candidates={analysis.textCandidates ?? []} removals={finalPlan.removals} manualOverrides={manualOverrides} rate={media.frameRate.numerator / media.frameRate.denominator} currentTime={currentTime} playing={playing} active={textMode && !projectSwitchAction && !setupOpen && !storageOpen} onSeek={seek} onPlayRange={playReview} onEdit={(action, start, end) => reviewBatch([{ action, start, end }])} onBatch={reviewBatch} onUndo={undo} canUndo={past.length > 0}/>}

        <section className="viewer-panel panel"><div className="panel-heading"><span>{t("preview")}</span>{timelineSize && <small>{timelineSize.width}×{timelineSize.height}</small>}</div><div className="viewer">
          {source.previewUrl && [0, 1].map((index) => <video key={`${source.previewUrl}#${index}`} ref={playerRefs[index]} className={activePlayer === index ? "active" : ""} src={source.previewUrl} preload="auto" onTimeUpdate={onTimeUpdate}
            onPlay={(event) => { if (event.currentTarget === videoRef.current) setPlaying(true); }} onPause={(event) => { if (event.currentTarget === videoRef.current) setPlaying(false); }}
            onLoadedData={() => setPlaybackError(null)} onError={onVideoError} playsInline aria-hidden={activePlayer !== index} />)}
          {proxyBusy && <div className="process-overlay"><span className="spinner large"/><strong>{t("preparingPlayback")}</strong><span>{operation?.operation === "preview" && operation.percent != null ? t("buildingProxy", { percent: operation.percent }) : t("working")}</span><div className="progress-track"><i style={{ width: `${operation?.percent ?? 8}%` }}/></div><output>{operation?.percent == null ? t("working") : `${operation.percent}%`}</output><button onClick={cancelOperation}>{t("cancel")}</button></div>}
          {!source.previewUrl && !proxyBusy && !previewError && <div className="media-error"><strong>{t("proxyMissing")}</strong><span>{t("proxyMissingBody")}</span><button onClick={() => buildPreview(source)}>{t("rebuildPreview")}</button></div>}
          {previewError && !proxyBusy && <div className="media-error"><strong>{t("previewFailed")}</strong><span>{previewError}</span><button onClick={() => buildPreview(source)}>{t("tryAgain")}</button></div>}
          {playbackError && !proxyBusy && <div className="media-error"><strong>{t("playbackInterrupted")}</strong><span>{t("playbackSafe", { error: playbackError })}</span><div className="error-actions"><button onClick={reloadPlayback}>{t("reloadPreview")}</button><button onClick={() => buildPreview(source)}>{t("rebuildProxy")}</button></div></div>}
          <div className="viewer-grid" aria-hidden="true" />
        </div><div className="transport"><button className="transport-play" onClick={togglePlayback} disabled={!source.previewUrl} aria-label={playing ? t("pause") : t("play")}>{playing ? "Ⅱ" : "▶"}</button><output>{timecode(currentTime, media.frameRate)}</output><input className="transport-line" aria-label={t("sourcePosition")} type="range" min="0" max={media.duration} step={media.frameRate.denominator / media.frameRate.numerator} value={Math.min(currentTime, media.duration)} onChange={(event) => seek(Number(event.target.value))}/><button className={`preview-toggle ${preview ? "active" : ""}`} onClick={() => setPreview(!preview)} title={t("editedPreviewHint")}><i/> {t("editedPreview", { on: preview })}</button></div>
          {textMode && <div className="overview-wrap">{resultBlock}<Overview duration={media.duration} waveform={currentWaveform} keeps={keepSeconds} currentTime={currentTime} onSeek={seek} title={t("overview")}/></div>}
        </section>

        {inspector}

        <section className="timeline-panel panel"><div className="timeline-toolbar"><div><strong>{t("timeline")}</strong><Segmented label={t("timelineView")} value={timelineView} onChange={chooseTimelineView} options={[{ value: "source", label: t("viewSource") }, { value: "edited", label: t("viewEdited") }]}/></div>
          {analysisSignature ? <div className="toolbar-result"><span>{t("finalLength")}</span><strong>{clockTime(media.duration - removed)}</strong><small>{t("ofOriginal", { total: clockTime(media.duration), percent: Math.round(removed / media.duration * 100) })}</small></div> : <div/>}<div className="edit-tools"><ToolButton onClick={undo} disabled={!past.length} title={t("undo")}>↶</ToolButton><ToolButton onClick={redo} disabled={!future.length} title={t("redo")}>↷</ToolButton><label className="zoom-control">− <input aria-label={t("zoom")} type="range" min="0.5" max="20" step="0.5" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}/> +</label></div></div>
          <Timeline key={timelineView} collapsed={timelineView === "edited"} media={media} waveform={currentWaveform} keeps={keepSeconds} decisions={silenceDecisions} textCandidates={textDecisions} manualOverrides={manualOverrides} selection={selection} onSelect={selectDecision} onCreateRemove={(start, end) => createOverride("remove", start, end)} onSeek={seek} currentTime={currentTime} zoom={zoom}/>
          <div className="selection-bar">{selectedManual ? <><span>{t("manualEdit")}</span><output>{timecode(selectedManual.start, media.frameRate)} — {timecode(selectedManual.end, media.frameRate)}</output><button className={selectedManual.action === "remove" ? "active remove" : ""} onClick={() => setSelectedAction("remove")}>{t("remove")} <kbd>R</kbd></button><button className={selectedManual.action === "keep" ? "active keep" : ""} onClick={() => setSelectedAction("keep")}>{t("keep")} <kbd>K</kbd></button><button onClick={clearSelectedOverride}>{t("clear")} <kbd>⌫</kbd></button></> : selection ? <><span>{candidateLabel(selection.reason)}</span><output>{timecode(selection.start, media.frameRate)} — {timecode(selection.end, media.frameRate)}</output>{selection.applied ? <><button className="keep" onClick={() => createOverride("keep", selection.start, selection.end, selection.key)}>{t("keepRegion")}</button><button onClick={useAutomaticDecision}>{t("useSuggestion")}</button></> : <button className="remove" disabled={selection.canApply === false} title={selection.canApply === false ? t("noTiming") : undefined} onClick={() => createOverride("remove", selection.start, selection.end, selection.key)}>{selection.reason === "non-verbal" ? t("removeSound") : selection.requiresFactConfirmation ? t("confirmFact") : selection.requiresQualityConfirmation ? t("confirmTake") : t("removeTake")}</button>}</> : <span className="selection-hint">{timelineView === "edited" ? t("editedHint") : t("selectionHint")}</span>}</div>
        </section>
      </div>}
    {storageOpen && <StorageManager sourceId={source?.sourceId} onClose={() => setStorageOpen(false)} onDeleted={onProxiesDeleted}/>}
    {setupOpen && runtime?.coreReady && <SetupManager runtime={runtime} transcriptionModelId={transcriptionModelId} installing={setupBusy} operation={operation} error={setupError} onModelChange={chooseTranscriptionModel} onInstall={prepareOpenRoughCut} onCancel={cancelOperation} onClose={() => setSetupOpen(false)} onShowLogs={showLogs}/>}
    {projectSwitchAction && <ProjectSwitchDialog
      action={projectSwitchAction}
      currentName={source?.name}
      saving={saving}
      closing={closingProject}
      onCancel={() => setProjectSwitchAction(null)}
      onContinue={() => continueProjectSwitch()}
      onSaveAndContinue={() => continueProjectSwitch({ saveFirst: true })}
    />}
  </main>;
}

export default App;
