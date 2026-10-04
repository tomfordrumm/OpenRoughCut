import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyManualOverrides, removalAtFrame } from "../../src/edit-plan.js";
import { playbackFrameAtTime, seekTimeAfterRemoval } from "../../src/playback.js";
import { analysisFingerprint, analysisIsCurrent } from "../../src/session.js";
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeTranscriptionModelId } from "../../src/transcription-models.js";
import { resolveProjectResolution } from "../../src/project-resolution.js";
import "./styles.css";

const DEFAULT_SETTINGS = { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18 };
const EMPTY_ANALYSIS = { silences: [], silenceRemovals: [], automaticRemovals: [], textCandidates: [], transcript: null };
const TRANSCRIPTION_MODEL_STORAGE_KEY = "openroughcut.transcriptionModel";
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
  { value: "final-cut", label: "Final Cut Pro", button: "FCPXML" },
  { value: "premiere", label: "Premiere Pro", button: "XML" },
  { value: "resolve", label: "DaVinci Resolve", button: "OTIO" },
];

function timecode(value = 0, frameRate = { numerator: 30, denominator: 1 }) {
  const total = Math.max(0, value);
  const fps = frameRate.numerator / frameRate.denominator;
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), Math.floor(total % 60), Math.min(Math.round(fps) - 1, Math.floor((total % 1) * fps))];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

const framesToSeconds = (frames, rate) => frames * rate.denominator / rate.numerator;
const secondsToFrames = (seconds, rate) => Math.round(seconds * rate.numerator / rate.denominator);
const removedSeconds = (ranges, rate) => ranges.reduce((sum, range) => sum + framesToSeconds(range.endFrame - range.startFrame, rate), 0);
const candidateLabel = (reason) => reason === "false-start" ? "False start" : reason === "repeated-take" ? "Repeated take" : reason === "non-verbal" ? "Non-word sound" : reason === "remove" ? "Manual removal" : reason === "keep" ? "Manual keep" : "Silence";
const formatBytes = (bytes = 0) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** exponent)).toFixed(exponent > 2 ? 2 : 1)} ${units[exponent - 1]}`;
};
const formatDuration = (seconds) => Number.isFinite(seconds) ? timecode(seconds).slice(0, 8) : "—";

function Icon({ children }) { return <span className="icon" aria-hidden="true">{children}</span>; }
function ToolButton({ children, className = "", ...props }) { return <button className={`tool-button ${className}`} {...props}>{children}</button>; }

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
      <header><div><span>{closingProject ? "CLOSE PROJECT" : "SWITCH PROJECT"}</span><h2 id="project-switch-title">{closingProject ? "Return to the start screen?" : openingSavedProject ? "Open another project?" : "Start a new project?"}</h2></div><button onClick={onCancel} disabled={pending} aria-label="Close">×</button></header>
      <div className="project-switch-copy">
        <strong title={currentName}>{currentName}</strong>
        <p>{closingProject ? "Closing this project returns you to the start screen and clears its recovery copy." : openingSavedProject ? "Opening a saved project will close the video currently on your timeline." : "A new project starts with a different source video and an empty timeline."}</p>
        <p>Save the current project first if you want to return to these edits later.</p>
      </div>
      <footer>
        <button className="secondary" onClick={onCancel} disabled={pending}>Cancel</button>
        <button className="secondary danger" onClick={onContinue} disabled={pending}>{closing ? "Closing…" : closingProject ? "Close without saving" : "Continue without saving"}</button>
        <button className="primary" onClick={onSaveAndContinue} disabled={pending}>{saving ? "Saving…" : closingProject ? "Save current & close" : "Save current & continue"}</button>
      </footer>
    </section>
  </div>;
}

function SetupManager({ runtime, transcriptionModelId, blocking = false, installing, operation, error, onModelChange, onInstall, onCancel, onClose, onShowLogs }) {
  const editingReady = Boolean(runtime?.ffmpeg?.ready && runtime?.ffprobe?.ready);
  const transcriptionReady = Boolean(runtime?.whisper?.ready && runtime?.model?.ready && runtime?.vadModel?.ready);
  const allReady = editingReady && transcriptionReady;
  const sourceText = (items) => items.some((item) => item?.source === "downloaded") ? "Installed for OpenRoughCut" : items.some((item) => item?.source === "system") ? "Found on this computer" : "Included with OpenRoughCut";
  const row = (label, ready, items, missingText) => <div className={ready ? "ready" : "missing"}><i>{ready ? "✓" : "↓"}</i><span><strong>{label}</strong><small>{ready ? sourceText(items) : missingText}</small></span></div>;
  return <div className={blocking ? "setup-page" : "modal-backdrop"} role={blocking ? "main" : "presentation"} onMouseDown={(event) => { if (!blocking && event.target === event.currentTarget && !installing) onClose(); }}>
    <section className="setup-card" role={blocking ? undefined : "dialog"} aria-modal={blocking ? undefined : "true"} aria-labelledby="setup-title">
      <header><div><span>ONE-TIME SETUP</span><h1 id="setup-title">Prepare OpenRoughCut</h1></div>{!blocking && <button onClick={onClose} disabled={installing} aria-label="Close setup">×</button>}</header>
      <p>OpenRoughCut downloads the editing engine and private speech models it needs, verifies every file, and installs them only for this app. Your videos never leave this computer.</p>
      <div className="dependency-grid">
        {row("Video editing", editingReady, [runtime?.ffmpeg, runtime?.ffprobe], "Editing engine will be downloaded")}
        {row("Private transcription", transcriptionReady, [runtime?.whisper, runtime?.model, runtime?.vadModel], "Speech models will be downloaded")}
      </div>
      <label className="model-picker"><span><strong>Transcription quality</strong><small>Only the selected model will be downloaded. Previously installed models remain available.</small></span><select value={transcriptionModelId} onChange={(event) => onModelChange(event.target.value)} disabled={installing}>{(runtime?.models ?? []).map((model) => <option key={model.id} value={model.id}>{model.label} · {model.detail}{model.ready ? " · installed" : ""}</option>)}</select><small>{runtime?.models?.find((model) => model.id === transcriptionModelId)?.description}</small></label>
      {!runtime?.canInstall && !allReady && <div className="setup-warning"><strong>Automatic setup is unavailable on this computer.</strong><span>Reinstall OpenRoughCut from the correct official installer. Your videos and saved sessions will not be removed.</span></div>}
      {error && <div className="setup-error">{error}</div>}
      {installing && <div className="setup-progress" role="status" aria-live="polite"><div><i style={{ width: `${operation?.percent ?? 4}%` }}/></div><span>{operation?.message ?? "Preparing OpenRoughCut…"}</span></div>}
      <footer><span>{allReady ? "Video editing and private transcription are ready." : runtime?.canInstall ? `${formatBytes(runtime.installBytes)} download · internet connection required` : "This installation needs attention."}</span><div className="setup-actions"><button onClick={onShowLogs}>Logs</button>{installing ? <button className="secondary" onClick={onCancel}>Cancel</button> : runtime?.canInstall ? <button className="primary" onClick={onInstall}>{error ? "Try setup again" : "Download and prepare OpenRoughCut"}</button> : !blocking && <button className="primary" onClick={onClose}>Done</button>}</div></footer>
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
      <header><div><span>LOCAL CACHE / PROXY MEDIA</span><h2 id="storage-title">Storage manager</h2></div><button onClick={onClose} disabled={Boolean(deleting)} aria-label="Close storage manager">×</button></header>
      <div className="storage-summary"><div><span>TOTAL PROXIES</span><strong>{storage?.proxies.length ?? "—"}</strong></div><div><span>DISK USAGE</span><strong>{storage ? formatBytes(storage.totalSize) : "—"}</strong></div><button className={clearArmed ? "armed" : ""} onClick={clearAll} disabled={!storage?.proxies.length || Boolean(deleting)}>{deleting === "all" ? "DELETING…" : clearArmed ? "CONFIRM DELETE ALL" : "DELETE ALL"}</button></div>
      <div className="storage-location"><span>CACHE LOCATION</span><code>{storage?.cacheLocation ?? "Loading…"}</code></div>
      {error && <div className="storage-error">{error}</div>}
      <div className="proxy-list">
        {!storage && !error && <div className="storage-loading"><span className="spinner"/> READING CACHE…</div>}
        {storage?.proxies.length === 0 && <div className="storage-empty"><strong>NO PROXIES</strong><span>Playback proxies will appear here after opening a source video.</span></div>}
        {storage?.proxies.map((item, index) => <article className={item.current ? "current" : ""} key={item.id}>
          <div className="proxy-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="proxy-description"><div><strong title={item.sourceName}>{item.sourceName}</strong>{item.current && <i>CURRENT</i>}</div><span>{item.width ? `${item.width}×${item.height}` : "Legacy proxy"} · {formatDuration(item.duration)} · {new Date(item.modifiedAt).toLocaleString()}</span><code>{item.id}</code></div>
          <output>{formatBytes(item.size)}</output>
          <button onClick={() => remove([item])} disabled={Boolean(deleting)}>{deleting === item.id ? <span className="spinner"/> : "DELETE"}</button>
        </article>)}
      </div>
      <footer>Deleting a proxy never deletes the original video, session, transcript, or exported timeline. It will be rebuilt automatically when that source is opened again.</footer>
    </section>
  </div>;
}

function Timeline({ media, decisions, textCandidates, manualOverrides, selection, onSelect, onCreateRemove, onSeek, currentTime, zoom }) {
  const dragRef = useRef(null);
  const scrollRef = useRef(null);
  const scrollFrameRef = useRef(null);
  const [viewport, setViewport] = useState({ start: 0, end: media.duration });
  const duration = media.duration;
  const width = Math.max(1000, duration * zoom);
  const rulerStep = zoom >= 16 ? 10 : zoom >= 7 ? 30 : zoom >= 3 ? 60 : 120;
  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const visibleStart = element.scrollLeft / width * duration;
    const visibleDuration = element.clientWidth / width * duration;
    setViewport({ start: Math.max(0, visibleStart - visibleDuration), end: Math.min(duration, visibleStart + visibleDuration * 2) });
  }, [duration, width]);
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
    return Math.max(0, Math.min(duration, (event.clientX - rect.left) / width * duration));
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { start: pointerTime(event), moved: false };
  };
  const onPointerMove = (event) => {
    if (!dragRef.current) return;
    const end = pointerTime(event);
    if (Math.abs(end - dragRef.current.start) > Math.max(0.08, duration / width * 3)) dragRef.current.moved = true;
    dragRef.current.end = end;
    event.currentTarget.style.setProperty("--drag-start", `${Math.min(dragRef.current.start, end) / duration * 100}%`);
    event.currentTarget.style.setProperty("--drag-width", `${Math.abs(end - dragRef.current.start) / duration * 100}%`);
    event.currentTarget.dataset.dragging = dragRef.current.moved ? "true" : "false";
  };
  const onPointerUp = (event) => {
    const drag = dragRef.current;
    dragRef.current = null;
    event.currentTarget.dataset.dragging = "false";
    if (!drag) return;
    const end = drag.end ?? drag.start;
    if (drag.moved) onCreateRemove(Math.min(drag.start, end), Math.max(drag.start, end));
    else onSeek(drag.start);
  };
  const rangeButton = (item, className, lane) => <button
    type="button"
    key={item.key}
    className={`range ${className} ${selection?.key === item.key ? "selected" : ""}`}
    title={`${candidateLabel(item.reason)} · ${timecode(item.start, media.frameRate)}–${timecode(item.end, media.frameRate)}`}
    aria-label={`Select ${candidateLabel(item.reason)} removal`}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => { event.stopPropagation(); onSelect({ ...item, kind: lane }); onSeek(item.start); }}
    style={{ left: `${item.start / duration * 100}%`, width: `${(item.end - item.start) / duration * 100}%` }}
  />;

  return <div className="timeline-scroll" ref={scrollRef} onScroll={scheduleViewportUpdate}>
    <div className="timeline-canvas" style={{ width }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <div className="drag-ghost" />
      <div className="ruler">{ticks.map((tick) => <div className="tick" key={tick} style={{ left: `${tick / duration * 100}%` }}><span>{timecode(tick, media.frameRate).slice(0, 8)}</span></div>)}</div>
      <div className="track track-source"><span className="track-label">SOURCE</span></div>
      <div className="track track-auto"><span className="track-label">SILENCE</span>{visible(decisions).map((item) => rangeButton(item, "auto-range", "automatic"))}</div>
      {textCandidates.length > 0 && <div className="track track-text"><span className="track-label">SPEECH</span>{visible(textCandidates).map((item) => rangeButton(item, `text-range ${item.applied ? "applied" : "suggested"}`, "text"))}</div>}
      <div className="track track-manual"><span className="track-label">MANUAL</span>{visible(manualOverrides).map((item) => rangeButton({ ...item, key: `manual:${item.id}`, reason: item.action, start: item.start, end: item.end }, `manual-range ${item.action}`, "manual"))}</div>
      <div className="playhead" style={{ left: `${currentTime / duration * 100}%` }}><span /></div>
    </div>
  </div>;
}

function App() {
  const videoRef = useRef(null);
  const roughSeekRef = useRef(false);
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
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [removeNonVerbal, setRemoveNonVerbal] = useState(true);
  const [textConfidence, setTextConfidence] = useState(0.9);
  const [transcriptionModelId, setTranscriptionModelId] = useState(() => typeof window === "undefined"
    ? DEFAULT_TRANSCRIPTION_MODEL_ID
    : normalizeTranscriptionModelId(window.localStorage.getItem(TRANSCRIPTION_MODEL_STORAGE_KEY)));
  const [zoom, setZoom] = useState(2);
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
  const [autosaveState, setAutosaveState] = useState({ tone: "idle", text: "" });
  const [status, setStatus] = useState({ tone: "idle", text: "Choose a recording to begin" });
  const [operation, setOperation] = useState(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [projectSwitchAction, setProjectSwitchAction] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [playbackError, setPlaybackError] = useState(null);
  const media = source?.media;
  const operationBusy = busy || proxyBusy || setupBusy || saving || closingProject || openingVideo;
  const speechAnalysisEnabled = includeTranscript || removeNonVerbal;
  const analysisInput = useMemo(() => ({ settings, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId }), [settings, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId]);
  const analysisCurrent = analysisIsCurrent(analysisSignature, analysisInput);
  const analysisStale = Boolean(analysisSignature) && !analysisCurrent;

  const silenceDecisions = useMemo(() => (analysis.silenceRemovals?.length ? analysis.silenceRemovals : analysis.automaticRemovals ?? []).map((range, index) => ({ key: `silence:${index}`, reason: "silence", start: framesToSeconds(range.startFrame, media.frameRate), end: framesToSeconds(range.endFrame, media.frameRate), applied: true })), [analysis, media]);
  const textDecisions = useMemo(() => (analysis.textCandidates ?? []).map((item, index) => ({ ...item, key: `text:${item.id ?? index}` })), [analysis.textCandidates]);
  const displayedTextCandidates = useMemo(() => (analysis.textCandidates ?? []).slice(0, 200), [analysis.textCandidates]);
  const finalPlan = useMemo(() => {
    if (!media) return { removals: [], keeps: [], durationFrames: 0 };
    return applyManualOverrides(analysis.automaticRemovals ?? [], manualOverrides.map((range) => ({ action: range.action, startFrame: secondsToFrames(range.start, media.frameRate), endFrame: secondsToFrames(range.end, media.frameRate) })), secondsToFrames(media.duration, media.frameRate));
  }, [analysis.automaticRemovals, manualOverrides, media]);

  useEffect(() => window.roughcut.onProgress((update) => {
    setOperation(update);
    setStatus({ tone: update.phase === "error" ? "error" : update.phase === "done" ? "success" : update.phase === "cancelled" ? "idle" : "working", text: update.message });
  }), []);

  const buildPreview = useCallback(async (nextSource) => {
    setProxyBusy(true); setPreviewError(null); setPlaybackError(null); setOperation({ operation: "preview", phase: "running", message: "Preparing playback proxy…", percent: 0 });
    try {
      const result = await window.roughcut.preparePreview({ sourceId: nextSource.sourceId });
      setSource((current) => current?.sourceId === nextSource.sourceId ? { ...current, previewUrl: result.previewUrl } : current);
    } catch (error) {
      if (/cancelled/i.test(error.message)) setStatus({ tone: "idle", text: "Preview creation cancelled" });
      else { setPreviewError(error.message); setStatus({ tone: "error", text: `Preview failed · ${error.message}` }); }
    } finally { setProxyBusy(false); }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !media || !preview || typeof video.requestVideoFrameCallback !== "function") return undefined;
    let callbackId;
    const followFrame = (_now, metadata) => {
      const playbackFrame = playbackFrameAtTime(metadata.mediaTime, media.frameRate);
      const removal = !video.seeking && !roughSeekRef.current ? removalAtFrame(finalPlan.removals, playbackFrame) : null;
      if (removal) {
        roughSeekRef.current = true;
        const target = seekTimeAfterRemoval(removal.endFrame, media.frameRate, media.duration);
        video.currentTime = target;
        setCurrentTime(target);
        video.addEventListener("seeked", () => { roughSeekRef.current = false; }, { once: true });
      }
      callbackId = video.requestVideoFrameCallback(followFrame);
    };
    callbackId = video.requestVideoFrameCallback(followFrame);
    return () => video.cancelVideoFrameCallback(callbackId);
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
    if (video.paused) video.play().catch(() => setPlaybackError(true)); else video.pause();
  }, [source?.previewUrl]);

  useEffect(() => {
    const onKey = (event) => {
      const editable = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      else if (!editable && event.code === "Space") { event.preventDefault(); togglePlayback(); }
      else if (!editable && selectedManual && (event.key === "Backspace" || event.key === "Delete")) { event.preventDefault(); clearSelectedOverride(); }
      else if (!editable && selectedManual && event.key.toLowerCase() === "r") setSelectedAction("remove");
      else if (!editable && selectedManual && event.key.toLowerCase() === "k") setSelectedAction("keep");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, togglePlayback, clearSelectedOverride, selectedManual]);

  const installSource = useCallback((next, loaded = null) => {
    videoRef.current?.pause();
    setSource({ ...next, previewUrl: null }); setAnalysis(loaded?.analysis ?? EMPTY_ANALYSIS); setManualOverrides(loaded?.manualOverrides ?? []);
    setSessionPath(loaded?.sessionPath ?? null); setAnalysisSignature(loaded?.analysisSignature ?? null);
    setPast([]); setFuture([]); setSelection(null); setCurrentTime(0); setPreview(true); setPlaying(false); setZoom(2); setPreviewError(null); setPlaybackError(null); roughSeekRef.current = false;
    if (loaded) {
      setSettings(loaded.settings); setProjectResolution(loaded.projectResolution ?? "source"); setExportFormat(loaded.exportFormat ?? "final-cut");
      setIncludeTranscript(loaded.includeTranscript === true); setRemoveNonVerbal(loaded.removeNonVerbal === true); setTextConfidence(loaded.textConfidence ?? 0.9);
    } else {
      setSettings(DEFAULT_SETTINGS); setProjectResolution("source"); setExportFormat("final-cut"); setIncludeTranscript(false); setRemoveNonVerbal(true); setTextConfidence(0.9);
    }
    buildPreview(next);
  }, [buildPreview]);

  const resetProject = useCallback(() => {
    videoRef.current?.pause();
    setSource(null); setSessionPath(null); setSettings(DEFAULT_SETTINGS); setAnalysis(EMPTY_ANALYSIS); setAnalysisSignature(null); setManualOverrides([]);
    setPast([]); setFuture([]); setSelection(null); setProjectResolution("source"); setExportFormat("final-cut"); setIncludeTranscript(false); setRemoveNonVerbal(true); setTextConfidence(0.9);
    setZoom(2); setCurrentTime(0); setPreview(true); setPlaying(false); setOperation(null); setStorageOpen(false); setPreviewError(null); setPlaybackError(null); roughSeekRef.current = false;
    setAutosaveState({ tone: "idle", text: "" });
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
        setStatus({ tone: "success", text: recovered.sessionPath ? "Previous session restored" : "Recovered autosaved work" });
      } catch (error) {
        if (alive) setStatus({ tone: "error", text: `Recovery unavailable · ${error.message}` });
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
    transcriptionModelId,
    analysisSignature,
    analysis,
    manualOverrides,
  } : null, [source?.sourceId, sessionPath, settings, projectResolution, exportFormat, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId, analysisSignature, analysis, manualOverrides]);

  useEffect(() => {
    if (booting || !sessionPayload) return undefined;
    setAutosaveState({ tone: "working", text: "Saving recovery copy…" });
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.roughcut.autosaveSession(sessionPayload);
        setAutosaveState({ tone: "success", text: `Recovery saved ${new Date(result.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` });
      } catch (error) {
        setAutosaveState({ tone: "error", text: `Recovery save failed · ${error.message}` });
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
    setStatus({ tone: "working", text: "Choose a video to inspect…" });
    try {
      const next = await window.roughcut.chooseVideo();
      if (!next) { setStatus({ tone: "idle", text: "Choose a recording to begin" }); return false; }
      installSource(next); setStatus({ tone: "working", text: "New project created · preparing preview" });
      return true;
    } catch (error) { setStatus({ tone: "error", text: error.message }); return false; }
    finally { setOpeningVideo(false); }
  };
  const showLogs = async () => {
    try { await window.roughcut.showLogs(); }
    catch (error) { setStatus({ tone: "error", text: `Could not open diagnostic logs · ${error.message}` }); }
  };
  const analyze = async () => {
    if (!source || operationBusy) return;
    const nextSignature = analysisFingerprint(analysisInput);
    setBusy(true); setOperation({ operation: "analysis", phase: "running", message: "Starting analysis…", percent: null });
    try {
      const result = await window.roughcut.analyze({ sourceId: source.sourceId, settings, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId });
      setAnalysis(result); setAnalysisSignature(nextSignature); setSelection(null);
      setStatus({ tone: "success", text: `${result.automaticRemovals.length} applied cuts · ${result.textCandidates?.filter((item) => !item.applied).length ?? 0} review suggestions` });
    } catch (error) { setStatus({ tone: /cancelled/i.test(error.message) ? "idle" : "error", text: /cancelled/i.test(error.message) ? "Analysis cancelled" : error.message }); }
    finally { setBusy(false); }
  };
  const saveSession = async () => {
    if (!sessionPayload || saving) return false;
    setSaving(true);
    try {
      const saved = await window.roughcut.saveSession(sessionPayload);
      if (!saved) return false;
      setSessionPath(saved.path); setStatus({ tone: "success", text: `Saved · ${saved.path.split(/[\\/]/).at(-1)}` });
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
      installSource(loaded, loaded); setStatus({ tone: "working", text: "Project opened · preparing preview" });
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
      ? { tone: "error", text: `Project closed, but its recovery copy could not be cleared · ${closeError.message}` }
      : { tone: "idle", text: "Choose a recording to begin" });
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const exportProject = async () => {
    if (!source || operationBusy || !analysisCurrent) return;
    setBusy(true);
    try { const result = await window.roughcut.exportProject({ sourceId: source.sourceId, settings, includeTranscript, removeNonVerbal, textConfidence, transcriptionModelId, analysisSignature, projectResolution, exportFormat, automaticRemovals: analysis.automaticRemovals, manualOverrides }); if (result) setStatus({ tone: "success", text: `${result.label} exported · ${result.keptRanges} retained ranges${result.importNote ? ` · ${result.importNote}` : ""}` }); }
    catch (error) { setStatus({ tone: "error", text: error.message }); }
    finally { setBusy(false); }
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
  const seek = (seconds) => { if (videoRef.current) videoRef.current.currentTime = seconds; setCurrentTime(seconds); };
  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
  };
  const onVideoError = (event) => {
    const code = event.currentTarget.error?.code;
    const labels = { 1: "Playback was aborted", 2: "The proxy stream could not be read", 3: "Chromium could not decode a frame", 4: "Chromium could not open the proxy stream" };
    setPreview(false);
    roughSeekRef.current = false;
    setPlaybackError(labels[code] ?? "The video element reported an unknown playback error");
  };
  const reloadPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    const resumeAt = Math.min(currentTime, media.duration);
    setPlaybackError(null); setPreview(false); roughSeekRef.current = false;
    video.addEventListener("loadedmetadata", () => { video.currentTime = resumeAt; }, { once: true });
    video.load();
  };
  const onProxiesDeleted = (items) => {
    if (!items.some((item) => item.current)) return;
    videoRef.current?.pause();
    setSource((current) => current ? { ...current, previewUrl: null } : current);
    setPreviewError(null); setPlaybackError(null); setPlaying(false);
    setStatus({ tone: "idle", text: "Current proxy deleted · reopen or rebuild preview when needed" });
  };
  const selectDecision = (item) => setSelection(item);
  const removed = media ? removedSeconds(finalPlan.removals, media.frameRate) : 0;
  const timelineSize = source ? resolveProjectResolution(source.media, projectResolution) : null;
  const selectedExport = EXPORT_FORMATS.find((item) => item.value === exportFormat) ?? EXPORT_FORMATS[0];
  if (booting) return <main className="app-shell boot-shell"><section className="boot-splash"><span className="brand-mark">ORC</span><strong>Opening OpenRoughCut</strong><small>Checking editing tools and recovery data…</small><span className="spinner large"/></section></main>;
  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">RC</span><div><strong>ROUGH/CUT</strong><small>Smart silence editor</small></div></div>
      {runtime?.coreReady && <div className="top-actions">
        <span className={`autosave-state ${autosaveState.tone}`} title={autosaveState.text}>{autosaveState.text || "Recovery turns on after opening a source"}</span>
        <ToolButton className="new-project" onClick={() => requestProjectSwitch("new")} disabled={operationBusy} title="New project (⌘N)"><Icon>＋</Icon> New project</ToolButton>
        <ToolButton onClick={() => requestProjectSwitch("open")} disabled={operationBusy} title="Open project (⌘O)"><Icon>↥</Icon> Open project</ToolButton>
        <ToolButton onClick={saveSession} disabled={!source || operationBusy} title="Save project (⌘S)"><Icon>⌘</Icon> {saving ? "Saving…" : "Save project"}</ToolButton>
        <ToolButton onClick={() => setSetupOpen(true)} disabled={setupBusy}><Icon>{runtime?.transcriptionReady ? "✓" : "!"}</Icon> Setup</ToolButton>
        <ToolButton onClick={showLogs} title="Show diagnostic log"><Icon>≡</Icon> Logs</ToolButton>
        <ToolButton onClick={() => setStorageOpen(true)} disabled={operationBusy}><Icon>▤</Icon> Storage</ToolButton>
        <label className="export-target"><span>EXPORT</span><select aria-label="Timeline export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value)} disabled={operationBusy}>{EXPORT_FORMATS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <ToolButton className="primary" onClick={exportProject} disabled={!source || operationBusy || !analysisCurrent} title={analysisStale ? "Settings changed. Re-analyse before exporting." : !analysisSignature ? "Analyse the source before exporting." : undefined}><Icon>↗</Icon> Export {selectedExport.button}{timelineSize ? ` · ${timelineSize.width}×${timelineSize.height}` : ""}</ToolButton>
      </div>}
    </header>
    {!runtime?.coreReady ? <SetupManager runtime={runtime} transcriptionModelId={transcriptionModelId} blocking installing={setupBusy} operation={operation} error={setupError} onModelChange={chooseTranscriptionModel} onInstall={prepareOpenRoughCut} onCancel={cancelOperation} onClose={() => {}} onShowLogs={showLogs}/> : !source ? <section className="empty-state"><p className="eyebrow">EDIT FASTER, STAY IN CONTROL</p><h1>Remove silence.<br/><em>Keep every decision editable.</em></h1><p>Create a project from one recording, review the suggested cuts, and export an editable timeline to your video editor.</p><div className="empty-actions"><ToolButton className="hero-button" onClick={() => requestProjectSwitch("new")} disabled={openingVideo}>{openingVideo ? "Inspecting selected video…" : "Create project from video"} <Icon>{openingVideo ? "…" : "→"}</Icon></ToolButton><button className="open-project-link" onClick={() => requestProjectSwitch("open")} disabled={openingVideo}>Open a saved project</button></div>{(openingVideo || status.tone === "error") && <div className={`empty-open-status ${status.tone}`} role="status" aria-live="polite"><div><strong>{openingVideo ? "Inspecting video" : "Could not open video"}</strong><span>{status.text}</span></div>{status.tone === "error" && <button onClick={showLogs}>SHOW DIAGNOSTIC LOG</button>}</div>}<div className="format-note">MOV · MP4 · M4V · MKV · WEBM <span>Final Cut Pro · Premiere Pro · Resolve</span></div></section> :
      <div className="workspace">
        <section className="viewer-panel panel"><div className="panel-heading"><span>Preview</span><button onClick={() => requestProjectSwitch("close")} disabled={operationBusy}>Close project</button></div><div className="viewer">
          {source.previewUrl && <video ref={videoRef} key={source.previewUrl} src={source.previewUrl} preload="auto" onTimeUpdate={onTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedData={() => setPlaybackError(null)} onError={onVideoError} playsInline />}
          {proxyBusy && <div className="process-overlay"><span className="spinner large"/><strong>Preparing smooth playback</strong><span>{operation?.message}</span><div className="progress-track"><i style={{ width: `${operation?.percent ?? 8}%` }}/></div><output>{operation?.percent == null ? "Working…" : `${operation.percent}%`}</output><button onClick={cancelOperation}>Cancel</button></div>}
          {!source.previewUrl && !proxyBusy && !previewError && <div className="media-error"><strong>Preview proxy not available</strong><span>The original video and all edit decisions are still intact.</span><button onClick={() => buildPreview(source)}>REBUILD PREVIEW</button></div>}
          {previewError && !proxyBusy && <div className="media-error"><strong>Preview generation failed</strong><span>{previewError}</span><button onClick={() => buildPreview(source)}>TRY AGAIN</button></div>}
          {playbackError && !proxyBusy && <div className="media-error"><strong>Playback interrupted</strong><span>{playbackError}. Your analysis and edits are safe.</span><div className="error-actions"><button onClick={reloadPlayback}>RELOAD PREVIEW</button><button onClick={() => buildPreview(source)}>REBUILD PROXY</button></div></div>}
          <div className="viewer-grid" aria-hidden="true" />
        </div><div className="transport"><button className="transport-play" onClick={togglePlayback} disabled={!source.previewUrl} aria-label={playing ? "Pause" : "Play"}>{playing ? "Ⅱ" : "▶"}</button><output>{timecode(currentTime, media.frameRate)}</output><input className="transport-line" aria-label="Source position" type="range" min="0" max={media.duration} step={media.frameRate.denominator / media.frameRate.numerator} value={Math.min(currentTime, media.duration)} onChange={(event) => seek(Number(event.target.value))}/><button className={`preview-toggle ${preview ? "active" : ""}`} onClick={() => setPreview(!preview)} title="Skip removed regions during playback"><i/> Edited preview {preview ? "on" : "off"}</button></div></section>

        <aside className="inspector panel"><div className="panel-heading"><span>Analysis</span><span className={`status-lamp ${status.tone}`}/></div><div className="source-meta"><strong title={source.name}>{source.name}</strong><dl><div><dt>Source resolution</dt><dd>{media.width}×{media.height}</dd></div><div><dt>Frame rate</dt><dd>{(media.frameRate.numerator / media.frameRate.denominator).toFixed(2)} fps</dd></div><div><dt>Duration</dt><dd>{timecode(media.duration, media.frameRate).slice(0, 8)}</dd></div></dl></div>
          <fieldset className="control-stack" disabled={operationBusy}><label><span>Silence threshold <b>{settings.thresholdDb} dB</b></span><small>Audio quieter than this is treated as silence.</small><input type="range" min="-60" max="-15" step="1" value={settings.thresholdDb} onChange={(e) => setSettings({ ...settings, thresholdDb: Number(e.target.value) })}/></label><label><span>Minimum silence <b>{settings.minimumSilence.toFixed(2)} s</b></span><input type="range" min="0.2" max="3" step="0.05" value={settings.minimumSilence} onChange={(e) => { const minimumSilence = Number(e.target.value); setSettings({ ...settings, minimumSilence, keepPause: Math.min(settings.keepPause, Math.max(0, minimumSilence - 0.05)) }); }}/></label><label><span>Pause to keep <b>{settings.keepPause.toFixed(2)} s</b></span><input type="range" min="0" max={Math.max(0.05, settings.minimumSilence - 0.05)} step="0.01" value={Math.min(settings.keepPause, settings.minimumSilence - 0.05)} onChange={(e) => setSettings({ ...settings, keepPause: Number(e.target.value) })}/></label><label className="select-label"><span>Timeline resolution{exportFormat === "resolve" && <b>SET AFTER IMPORT</b>}</span><select value={projectResolution} onChange={(e) => setProjectResolution(e.target.value)}><option value="source">Source · {media.width}×{media.height} ({media.height > media.width ? "vertical" : media.width > media.height ? "landscape" : "square"})</option>{PROJECT_RESOLUTION_GROUPS.map((group) => <optgroup key={group.label} label={group.label}>{group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>)}</select>{exportFormat === "resolve" && <small className="control-note">OTIO cannot set this automatically. Apply the selected resolution in Resolve after import.</small>}</label></fieldset>
          <div className="transcribe-control"><label><input type="checkbox" checked={removeNonVerbal} onChange={(e) => setRemoveNonVerbal(e.target.checked)} disabled={operationBusy || !runtime.transcriptionReady}/><span><b>Remove sounds without words</b><small>Automatically cuts isolated sighs, clicks, and humming</small></span></label><label><input type="checkbox" checked={includeTranscript} onChange={(e) => setIncludeTranscript(e.target.checked)} disabled={operationBusy || !runtime.transcriptionReady}/><span><b>Find false starts and repeated takes</b><small>{runtime.transcriptionReady ? `Uses ${runtime.model?.label ?? "Whisper"} on this computer` : "Open Setup to install the selected transcription model"}</small></span></label>{!runtime.transcriptionReady && <button className="setup-link" onClick={() => setSetupOpen(true)}>Open Setup</button>}{includeTranscript && <label className="confidence"><span>Auto-remove confidence <b>{Math.round(textConfidence * 100)}%</b></span><input type="range" min="0.7" max="0.99" step="0.01" value={textConfidence} onChange={(e) => setTextConfidence(Number(e.target.value))} disabled={operationBusy}/></label>}</div>
          {analysisStale && <div className="analysis-warning"><strong>Analysis is out of date.</strong><span>Settings changed. Re-analyse to update the timeline and enable export.</span></div>}
          {!analysisSignature && <div className="analysis-notice">Analyse this source to create suggested cuts.</div>}
          <ToolButton className={`analyze-button ${busy ? "cancel" : ""}`} onClick={busy ? cancelOperation : analyze} disabled={!busy && (proxyBusy || setupBusy || (speechAnalysisEnabled && !runtime.transcriptionReady))}>{busy ? <>Cancel analysis</> : <>{analysisSignature ? "Re-analyse" : "Analyse source"} <Icon>↻</Icon></>}</ToolButton><div className={`status-line ${status.tone}`} role="status" aria-live="polite"><span>{status.text}</span>{busy && <i className="indeterminate"/>}</div>
          <div className="summary-meters"><div><span>Suggested cuts</span><strong>{analysis.automaticRemovals?.length ?? 0}</strong></div><div><span>Manual edits</span><strong>{manualOverrides.length}</strong></div><div className="wide"><span>Removed / total</span><strong>{timecode(removed, media.frameRate).slice(0, 8)} <small>/ {timecode(media.duration, media.frameRate).slice(0, 8)}</small></strong></div></div>
          {analysis.textCandidates?.length > 0 && <section className="transcript-panel"><header><span>Speech decisions</span><b>{analysis.textCandidates.length}</b></header>{displayedTextCandidates.map((item, index) => { const key = `text:${item.id ?? index}`; return <button key={key} className={`${item.applied ? "applied" : "suggested"} ${selection?.key === key ? "selected" : ""}`} onClick={() => { selectDecision({ ...item, key, kind: "text" }); seek(item.start); }}><span>{candidateLabel(item.reason)} · {Math.round(item.confidence * 100)}% <i>{item.applied ? "REMOVING" : "REVIEW"}</i></span><strong>{item.removedText}</strong><small>{item.reason === "non-verbal" ? "No spoken words in this isolated sound" : `Keep: ${item.keptText}`}</small></button>; })}{analysis.textCandidates.length > displayedTextCandidates.length && <p>Showing the first {displayedTextCandidates.length} suggestions. All suggestions remain visible on the timeline.</p>}</section>}
        </aside>

        <section className="timeline-panel panel"><div className="timeline-toolbar"><div><strong>Timeline</strong></div><div className="edit-tools"><ToolButton onClick={undo} disabled={!past.length} title="Undo (⌘Z)">↶</ToolButton><ToolButton onClick={redo} disabled={!future.length} title="Redo (⇧⌘Z)">↷</ToolButton><label className="zoom-control">− <input aria-label="Timeline zoom" type="range" min="0.5" max="20" step="0.5" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}/> +</label></div></div>
          <Timeline media={media} decisions={silenceDecisions} textCandidates={textDecisions} manualOverrides={manualOverrides} selection={selection} onSelect={selectDecision} onCreateRemove={(start, end) => createOverride("remove", start, end)} onSeek={seek} currentTime={currentTime} zoom={zoom}/>
          <div className="selection-bar">{selectedManual ? <><span>Manual edit</span><output>{timecode(selectedManual.start, media.frameRate)} — {timecode(selectedManual.end, media.frameRate)}</output><button className={selectedManual.action === "remove" ? "active remove" : ""} onClick={() => setSelectedAction("remove")}>Remove <kbd>R</kbd></button><button className={selectedManual.action === "keep" ? "active keep" : ""} onClick={() => setSelectedAction("keep")}>Keep <kbd>K</kbd></button><button onClick={clearSelectedOverride}>Clear <kbd>⌫</kbd></button></> : selection ? <><span>{candidateLabel(selection.reason)}</span><output>{timecode(selection.start, media.frameRate)} — {timecode(selection.end, media.frameRate)}</output>{selection.applied ? <><button className="keep" onClick={() => createOverride("keep", selection.start, selection.end, selection.key)}>Keep region</button><button onClick={useAutomaticDecision}>Use suggestion</button></> : <button className="remove" onClick={() => createOverride("remove", selection.start, selection.end, selection.key)}>{selection.reason === "non-verbal" ? "Remove sound" : "Remove take"}</button>}</> : <span className="selection-hint">Click a colored region to review it, or drag anywhere on the timeline to remove a range.</span>}</div>
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
