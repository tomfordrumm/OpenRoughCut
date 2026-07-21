import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyManualOverrides, removalAtFrame } from "../../src/edit-plan.js";
import { analysisFingerprint, analysisIsCurrent } from "../../src/session.js";
import "./styles.css";

const DEFAULT_SETTINGS = { thresholdDb: -35, minimumSilence: 0.7, keepPause: 0.18 };
const EMPTY_ANALYSIS = { silences: [], silenceRemovals: [], automaticRemovals: [], textCandidates: [], transcript: null };
const PROJECT_RESOLUTIONS = [
  { value: "source", label: "Source" },
  { value: "4k", label: "UHD 4K · 3840×2160" },
  { value: "full-hd", label: "Full HD · 1920×1080" },
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
const candidateLabel = (reason) => reason === "false-start" ? "False start" : reason === "repeated-take" ? "Repeated take" : reason === "remove" ? "Manual removal" : reason === "keep" ? "Manual keep" : "Silence";
const formatBytes = (bytes = 0) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** exponent)).toFixed(exponent > 2 ? 2 : 1)} ${units[exponent - 1]}`;
};
const formatDuration = (seconds) => Number.isFinite(seconds) ? timecode(seconds).slice(0, 8) : "—";

function Icon({ children }) { return <span className="icon" aria-hidden="true">{children}</span>; }
function ToolButton({ children, className = "", ...props }) { return <button className={`tool-button ${className}`} {...props}>{children}</button>; }

function SetupManager({ runtime, blocking = false, installing, operation, error, onInstall, onCancel, onClose }) {
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
      {!runtime?.canInstall && !allReady && <div className="setup-warning"><strong>Automatic setup is unavailable on this computer.</strong><span>Reinstall OpenRoughCut from the correct official installer. Your videos and saved sessions will not be removed.</span></div>}
      {error && <div className="setup-error">{error}</div>}
      {installing && <div className="setup-progress" role="status" aria-live="polite"><div><i style={{ width: `${operation?.percent ?? 4}%` }}/></div><span>{operation?.message ?? "Preparing OpenRoughCut…"}</span></div>}
      <footer><span>{allReady ? "Video editing and private transcription are ready." : runtime?.canInstall ? `${formatBytes(runtime.installBytes)} download · internet connection required` : "This installation needs attention."}</span>{installing ? <button className="secondary" onClick={onCancel}>Cancel</button> : runtime?.canInstall ? <button className="primary" onClick={onInstall}>{error ? "Try setup again" : "Download and prepare OpenRoughCut"}</button> : !blocking && <button className="primary" onClick={onClose}>Done</button>}</footer>
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
      {textCandidates.length > 0 && <div className="track track-text"><span className="track-label">TRANSCRIPT</span>{visible(textCandidates).map((item) => rangeButton(item, `text-range ${item.applied ? "applied" : "suggested"}`, "text"))}</div>}
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
  const [textConfidence, setTextConfidence] = useState(0.9);
  const [zoom, setZoom] = useState(2);
  const [currentTime, setCurrentTime] = useState(0);
  const [preview, setPreview] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
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
  const [previewError, setPreviewError] = useState(null);
  const [playbackError, setPlaybackError] = useState(null);
  const media = source?.media;
  const operationBusy = busy || proxyBusy || setupBusy || saving;
  const analysisInput = useMemo(() => ({ settings, includeTranscript, textConfidence }), [settings, includeTranscript, textConfidence]);
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
      const playbackFrame = Math.floor(metadata.mediaTime * media.frameRate.numerator / media.frameRate.denominator);
      const removal = !video.seeking && !roughSeekRef.current ? removalAtFrame(finalPlan.removals, playbackFrame) : null;
      if (removal) {
        roughSeekRef.current = true;
        const target = framesToSeconds(removal.endFrame, media.frameRate);
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
    setSource({ ...next, previewUrl: null }); setAnalysis(loaded?.analysis ?? EMPTY_ANALYSIS); setManualOverrides(loaded?.manualOverrides ?? []);
    setSessionPath(loaded?.sessionPath ?? null); setAnalysisSignature(loaded?.analysisSignature ?? null);
    setPast([]); setFuture([]); setSelection(null); setCurrentTime(0); setPreview(true); setPreviewError(null); setPlaybackError(null); roughSeekRef.current = false;
    if (loaded) {
      setSettings(loaded.settings); setProjectResolution(loaded.projectResolution ?? "source"); setExportFormat(loaded.exportFormat ?? "final-cut");
      setIncludeTranscript(loaded.includeTranscript === true); setTextConfidence(loaded.textConfidence ?? 0.9);
    } else {
      setSettings(DEFAULT_SETTINGS); setIncludeTranscript(false); setTextConfidence(0.9);
    }
    buildPreview(next);
  }, [buildPreview]);

  useEffect(() => {
    let alive = true;
    const bootstrap = async () => {
      try {
        const nextRuntime = await window.roughcut.runtimeStatus();
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
    textConfidence,
    analysisSignature,
    analysis,
    manualOverrides,
  } : null, [source?.sourceId, sessionPath, settings, projectResolution, exportFormat, includeTranscript, textConfidence, analysisSignature, analysis, manualOverrides]);

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
    if (operationBusy) return;
    try { const next = await window.roughcut.chooseVideo(); if (next) { installSource(next); setStatus({ tone: "working", text: "Source loaded · preparing preview" }); } }
    catch (error) { setStatus({ tone: "error", text: error.message }); }
  };
  const analyze = async () => {
    if (!source || operationBusy) return;
    const nextSignature = analysisFingerprint(analysisInput);
    setBusy(true); setOperation({ operation: "analysis", phase: "running", message: "Starting analysis…", percent: null });
    try {
      const result = await window.roughcut.analyze({ sourceId: source.sourceId, settings, includeTranscript, textConfidence });
      setAnalysis(result); setAnalysisSignature(nextSignature); setSelection(null);
      setStatus({ tone: "success", text: `${result.automaticRemovals.length} applied cuts · ${result.textCandidates?.filter((item) => !item.applied).length ?? 0} text suggestions` });
    } catch (error) { setStatus({ tone: /cancelled/i.test(error.message) ? "idle" : "error", text: /cancelled/i.test(error.message) ? "Analysis cancelled" : error.message }); }
    finally { setBusy(false); }
  };
  const saveSession = async () => {
    if (!sessionPayload || saving) return;
    setSaving(true);
    try { const saved = await window.roughcut.saveSession(sessionPayload); if (saved) { setSessionPath(saved.path); setStatus({ tone: "success", text: `Saved · ${saved.path.split(/[\\/]/).at(-1)}` }); } }
    catch (error) { setStatus({ tone: "error", text: error.message }); }
    finally { setSaving(false); }
  };
  const loadSession = async () => {
    if (operationBusy) return;
    try { const loaded = await window.roughcut.loadSession(); if (loaded) { installSource(loaded, loaded); setStatus({ tone: "working", text: "Session loaded · preparing preview" }); } }
    catch (error) { setStatus({ tone: "error", text: error.message }); }
  };
  const exportProject = async () => {
    if (!source || operationBusy || !analysisCurrent) return;
    setBusy(true);
    try { const result = await window.roughcut.exportProject({ sourceId: source.sourceId, settings, includeTranscript, textConfidence, analysisSignature, projectResolution, exportFormat, automaticRemovals: analysis.automaticRemovals, manualOverrides }); if (result) setStatus({ tone: "success", text: `${result.label} exported · ${result.keptRanges} retained ranges${result.importNote ? ` · ${result.importNote}` : ""}` }); }
    catch (error) { setStatus({ tone: "error", text: error.message }); }
    finally { setBusy(false); }
  };
  const cancelOperation = async () => { await window.roughcut.cancelOperation(); };
  const prepareOpenRoughCut = async () => {
    setSetupBusy(true); setSetupError(null);
    try { const next = await window.roughcut.installDependencies(); setRuntime(next); if (next.coreReady) setSetupOpen(false); }
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
  const selectedExport = EXPORT_FORMATS.find((item) => item.value === exportFormat) ?? EXPORT_FORMATS[0];
  if (booting) return <main className="app-shell boot-shell"><section className="boot-splash"><span className="brand-mark">ORC</span><strong>Opening OpenRoughCut</strong><small>Checking editing tools and recovery data…</small><span className="spinner large"/></section></main>;
  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">RC</span><div><strong>ROUGH/CUT</strong><small>Smart silence editor</small></div></div>
      {runtime?.coreReady && <div className="top-actions">
        <span className={`autosave-state ${autosaveState.tone}`} title={autosaveState.text}>{autosaveState.text || "Recovery turns on after opening a source"}</span>
        <ToolButton onClick={() => setSetupOpen(true)} disabled={setupBusy}><Icon>{runtime?.transcriptionReady ? "✓" : "!"}</Icon> Setup</ToolButton>
        <ToolButton onClick={() => setStorageOpen(true)} disabled={operationBusy}><Icon>▤</Icon> Storage</ToolButton>
        <ToolButton onClick={loadSession} disabled={operationBusy}><Icon>↥</Icon> Open</ToolButton>
        <ToolButton onClick={saveSession} disabled={!source || operationBusy}><Icon>⌘</Icon> {saving ? "Saving…" : "Save"}</ToolButton>
        <label className="export-target"><span>EXPORT</span><select aria-label="Timeline export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value)} disabled={operationBusy}>{EXPORT_FORMATS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <ToolButton className="primary" onClick={exportProject} disabled={!source || operationBusy || !analysisCurrent} title={analysisStale ? "Settings changed. Re-analyse before exporting." : !analysisSignature ? "Analyse the source before exporting." : undefined}><Icon>↗</Icon> Export {selectedExport.button}</ToolButton>
      </div>}
    </header>
    {!runtime?.coreReady ? <SetupManager runtime={runtime} blocking installing={setupBusy} operation={operation} error={setupError} onInstall={prepareOpenRoughCut} onCancel={cancelOperation} onClose={() => {}}/> : !source ? <section className="empty-state"><p className="eyebrow">EDIT FASTER, STAY IN CONTROL</p><h1>Remove silence.<br/><em>Keep every decision editable.</em></h1><p>Open one recording, review the suggested cuts, and export an editable timeline to your video editor.</p><ToolButton className="hero-button" onClick={chooseVideo}>Open video <Icon>→</Icon></ToolButton><div className="format-note">MOV · MP4 · M4V · MKV · WEBM <span>Final Cut Pro · Premiere Pro · Resolve</span></div></section> :
      <div className="workspace">
        <section className="viewer-panel panel"><div className="panel-heading"><span>Preview</span><button onClick={chooseVideo} disabled={operationBusy}>Replace video</button></div><div className="viewer">
          {source.previewUrl && <video ref={videoRef} key={source.previewUrl} src={source.previewUrl} onTimeUpdate={onTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedData={() => setPlaybackError(null)} onError={onVideoError} playsInline />}
          {proxyBusy && <div className="process-overlay"><span className="spinner large"/><strong>Preparing smooth playback</strong><span>{operation?.message}</span><div className="progress-track"><i style={{ width: `${operation?.percent ?? 8}%` }}/></div><output>{operation?.percent == null ? "Working…" : `${operation.percent}%`}</output><button onClick={cancelOperation}>Cancel</button></div>}
          {!source.previewUrl && !proxyBusy && !previewError && <div className="media-error"><strong>Preview proxy not available</strong><span>The original video and all edit decisions are still intact.</span><button onClick={() => buildPreview(source)}>REBUILD PREVIEW</button></div>}
          {previewError && !proxyBusy && <div className="media-error"><strong>Preview generation failed</strong><span>{previewError}</span><button onClick={() => buildPreview(source)}>TRY AGAIN</button></div>}
          {playbackError && !proxyBusy && <div className="media-error"><strong>Playback interrupted</strong><span>{playbackError}. Your analysis and edits are safe.</span><div className="error-actions"><button onClick={reloadPlayback}>RELOAD PREVIEW</button><button onClick={() => buildPreview(source)}>REBUILD PROXY</button></div></div>}
          <div className="viewer-grid" aria-hidden="true" />
        </div><div className="transport"><button className="transport-play" onClick={togglePlayback} disabled={!source.previewUrl} aria-label={playing ? "Pause" : "Play"}>{playing ? "Ⅱ" : "▶"}</button><output>{timecode(currentTime, media.frameRate)}</output><input className="transport-line" aria-label="Source position" type="range" min="0" max={media.duration} step={media.frameRate.denominator / media.frameRate.numerator} value={Math.min(currentTime, media.duration)} onChange={(event) => seek(Number(event.target.value))}/><button className={`preview-toggle ${preview ? "active" : ""}`} onClick={() => setPreview(!preview)} title="Skip removed regions during playback"><i/> Edited preview {preview ? "on" : "off"}</button></div></section>

        <aside className="inspector panel"><div className="panel-heading"><span>Analysis</span><span className={`status-lamp ${status.tone}`}/></div><div className="source-meta"><strong title={source.name}>{source.name}</strong><dl><div><dt>Resolution</dt><dd>{media.width}×{media.height}</dd></div><div><dt>Frame rate</dt><dd>{(media.frameRate.numerator / media.frameRate.denominator).toFixed(2)} fps</dd></div><div><dt>Duration</dt><dd>{timecode(media.duration, media.frameRate).slice(0, 8)}</dd></div></dl></div>
          <fieldset className="control-stack" disabled={operationBusy}><label><span>Silence threshold <b>{settings.thresholdDb} dB</b></span><small>Audio quieter than this is treated as silence.</small><input type="range" min="-60" max="-15" step="1" value={settings.thresholdDb} onChange={(e) => setSettings({ ...settings, thresholdDb: Number(e.target.value) })}/></label><label><span>Minimum silence <b>{settings.minimumSilence.toFixed(2)} s</b></span><input type="range" min="0.2" max="3" step="0.05" value={settings.minimumSilence} onChange={(e) => { const minimumSilence = Number(e.target.value); setSettings({ ...settings, minimumSilence, keepPause: Math.min(settings.keepPause, Math.max(0, minimumSilence - 0.05)) }); }}/></label><label><span>Pause to keep <b>{settings.keepPause.toFixed(2)} s</b></span><input type="range" min="0" max={Math.max(0.05, settings.minimumSilence - 0.05)} step="0.01" value={Math.min(settings.keepPause, settings.minimumSilence - 0.05)} onChange={(e) => setSettings({ ...settings, keepPause: Number(e.target.value) })}/></label><label className="select-label"><span>Timeline resolution{exportFormat === "resolve" && <b>SET AFTER IMPORT</b>}</span><select value={projectResolution} onChange={(e) => setProjectResolution(e.target.value)}>{PROJECT_RESOLUTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}{option.value === "source" ? ` · ${media.width}×${media.height}` : ""}</option>)}</select>{exportFormat === "resolve" && <small className="control-note">OTIO cannot set this automatically. Apply the selected resolution in Resolve after import.</small>}</label></fieldset>
          <div className="transcribe-control"><label><input type="checkbox" checked={includeTranscript} onChange={(e) => setIncludeTranscript(e.target.checked)} disabled={operationBusy || !runtime.transcriptionReady}/><span><b>Find false starts and repeated takes</b><small>{runtime.transcriptionReady ? "Uses on-device Whisper transcription" : "Open Setup to install transcription models"}</small></span></label>{!runtime.transcriptionReady && <button className="setup-link" onClick={() => setSetupOpen(true)}>Open Setup</button>}{includeTranscript && <label className="confidence"><span>Auto-remove confidence <b>{Math.round(textConfidence * 100)}%</b></span><input type="range" min="0.7" max="0.99" step="0.01" value={textConfidence} onChange={(e) => setTextConfidence(Number(e.target.value))} disabled={operationBusy}/></label>}</div>
          {analysisStale && <div className="analysis-warning"><strong>Analysis is out of date.</strong><span>Settings changed. Re-analyse to update the timeline and enable export.</span></div>}
          {!analysisSignature && <div className="analysis-notice">Analyse this source to create suggested cuts.</div>}
          <ToolButton className={`analyze-button ${busy ? "cancel" : ""}`} onClick={busy ? cancelOperation : analyze} disabled={!busy && (proxyBusy || setupBusy)}>{busy ? <>Cancel analysis</> : <>{analysisSignature ? "Re-analyse" : "Analyse source"} <Icon>↻</Icon></>}</ToolButton><div className={`status-line ${status.tone}`} role="status" aria-live="polite"><span>{status.text}</span>{busy && <i className="indeterminate"/>}</div>
          <div className="summary-meters"><div><span>Suggested cuts</span><strong>{analysis.automaticRemovals?.length ?? 0}</strong></div><div><span>Manual edits</span><strong>{manualOverrides.length}</strong></div><div className="wide"><span>Removed / total</span><strong>{timecode(removed, media.frameRate).slice(0, 8)} <small>/ {timecode(media.duration, media.frameRate).slice(0, 8)}</small></strong></div></div>
          {analysis.textCandidates?.length > 0 && <section className="transcript-panel"><header><span>Transcript suggestions</span><b>{analysis.textCandidates.length}</b></header>{displayedTextCandidates.map((item, index) => { const key = `text:${item.id ?? index}`; return <button key={key} className={`${item.applied ? "applied" : "suggested"} ${selection?.key === key ? "selected" : ""}`} onClick={() => { selectDecision({ ...item, key, kind: "text" }); seek(item.start); }}><span>{candidateLabel(item.reason)} · {Math.round(item.confidence * 100)}% <i>{item.applied ? "REMOVING" : "REVIEW"}</i></span><strong>{item.removedText}</strong><small>Keep: {item.keptText}</small></button>; })}{analysis.textCandidates.length > displayedTextCandidates.length && <p>Showing the first {displayedTextCandidates.length} suggestions. All suggestions remain visible on the timeline.</p>}</section>}
        </aside>

        <section className="timeline-panel panel"><div className="timeline-toolbar"><div><strong>Timeline</strong></div><div className="edit-tools"><ToolButton onClick={undo} disabled={!past.length} title="Undo (⌘Z)">↶</ToolButton><ToolButton onClick={redo} disabled={!future.length} title="Redo (⇧⌘Z)">↷</ToolButton><label className="zoom-control">− <input aria-label="Timeline zoom" type="range" min="0.5" max="20" step="0.5" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}/> +</label></div></div>
          <Timeline media={media} decisions={silenceDecisions} textCandidates={textDecisions} manualOverrides={manualOverrides} selection={selection} onSelect={selectDecision} onCreateRemove={(start, end) => createOverride("remove", start, end)} onSeek={seek} currentTime={currentTime} zoom={zoom}/>
          <div className="selection-bar">{selectedManual ? <><span>Manual edit</span><output>{timecode(selectedManual.start, media.frameRate)} — {timecode(selectedManual.end, media.frameRate)}</output><button className={selectedManual.action === "remove" ? "active remove" : ""} onClick={() => setSelectedAction("remove")}>Remove <kbd>R</kbd></button><button className={selectedManual.action === "keep" ? "active keep" : ""} onClick={() => setSelectedAction("keep")}>Keep <kbd>K</kbd></button><button onClick={clearSelectedOverride}>Clear <kbd>⌫</kbd></button></> : selection ? <><span>{candidateLabel(selection.reason)}</span><output>{timecode(selection.start, media.frameRate)} — {timecode(selection.end, media.frameRate)}</output>{selection.applied ? <><button className="keep" onClick={() => createOverride("keep", selection.start, selection.end, selection.key)}>Keep region</button><button onClick={useAutomaticDecision}>Use suggestion</button></> : <button className="remove" onClick={() => createOverride("remove", selection.start, selection.end, selection.key)}>Remove take</button>}</> : <span className="selection-hint">Click a colored region to review it, or drag anywhere on the timeline to remove a range.</span>}</div>
        </section>
      </div>}
    {storageOpen && <StorageManager sourceId={source?.sourceId} onClose={() => setStorageOpen(false)} onDeleted={onProxiesDeleted}/>} 
    {setupOpen && runtime?.coreReady && <SetupManager runtime={runtime} installing={setupBusy} operation={operation} error={setupError} onInstall={prepareOpenRoughCut} onCancel={cancelOperation} onClose={() => setSetupOpen(false)}/>} 
  </main>;
}

export default App;
