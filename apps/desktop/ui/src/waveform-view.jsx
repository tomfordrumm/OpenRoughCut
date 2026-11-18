import React, { useEffect, useRef } from "react";

const KEPT = "#9fd9cf";
const REMOVED = "#3b403d";
const NO_AUDIO = "#2a2e2c";

/**
 * Draw peaks between `start` and `end` seconds across the canvas. Each pixel
 * column shows the loudest peak it covers; kept audio is bright, removed dim.
 * `keeps` are sorted { start, end } ranges in seconds.
 */
function draw(canvas, { waveform, keeps, start, end }) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  const span = end - start;
  if (!(span > 0)) return;
  const middle = height / 2;
  if (!waveform?.peaks?.length) {
    context.fillStyle = NO_AUDIO;
    context.fillRect(0, middle - ratio / 2, width, ratio);
    return;
  }
  const { peaks, peaksPerSecond } = waveform;
  let keepIndex = 0;
  const step = Math.max(1, Math.floor(ratio));
  for (let x = 0; x < width; x += step) {
    const t0 = start + (x / width) * span;
    const t1 = start + ((x + step) / width) * span;
    let peak = 0;
    const last = Math.min(peaks.length - 1, Math.ceil(t1 * peaksPerSecond));
    for (let i = Math.max(0, Math.floor(t0 * peaksPerSecond)); i <= last; i++) if (peaks[i] > peak) peak = peaks[i];
    const centre = (t0 + t1) / 2;
    while (keepIndex < keeps.length && keeps[keepIndex].end <= centre) keepIndex++;
    const kept = keepIndex < keeps.length && keeps[keepIndex].start <= centre;
    const bar = Math.max(ratio, (peak / 255) * (height - 2 * ratio));
    context.fillStyle = kept ? KEPT : REMOVED;
    context.fillRect(x, middle - bar / 2, step, bar);
  }
}

export function WaveformCanvas({ waveform, keeps, start, end, className = "", style }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const render = () => draw(canvas, { waveform, keeps, start, end });
    render();
    const observer = new ResizeObserver(render);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [waveform, keeps, start, end]);
  return <canvas ref={ref} className={`waveform-canvas ${className}`} style={style} aria-hidden="true" />;
}

/** The whole recording in one strip: waveform, kept parts and the playhead. */
export function Overview({ duration, waveform, keeps, currentTime, onSeek, title }) {
  const seekAt = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration)));
  };
  return <div className="overview-strip" title={title} role="slider" aria-label={title} aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(currentTime)} tabIndex={-1}
    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); seekAt(event); }}
    onPointerMove={(event) => { if (event.buttons === 1) seekAt(event); }}>
    {keeps.map((keep) => <i key={`${keep.start}`} className="overview-keep" style={{ left: `${keep.start / duration * 100}%`, width: `${(keep.end - keep.start) / duration * 100}%` }} />)}
    <WaveformCanvas waveform={waveform} keeps={keeps} start={0} end={duration} />
    <b className="overview-playhead" style={{ left: `${Math.min(1, currentTime / duration) * 100}%` }} />
  </div>;
}
