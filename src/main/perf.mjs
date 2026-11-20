// Latency measuring helpers for the [perf] lines in main.log (docs/optimize-plan.md §1).

// RMS of 16-bit little-endian PCM, 0..32768. Used to know when the user last spoke.
export function rms16(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}
// shortcut: a fixed level, about -36 dBFS after the browser's noise suppression; calibrate per mic if V1 looks off.
export const VOICE_RMS = 500;

// Mic level for the log: feed(rms, now) per chunk returns { line, warn } every windowMs, else null.
// warn is set once per meter (one session) when 30 s of mic never reached VOICE_RMS: a dead, muted or low-gain mic.
export function micMeter(windowMs = 5000, warnMs = 30000) {
  let first = null, start = 0, peak = 0, loud = 0, n = 0, everLoud = false, warned = false;
  return (rms, now) => {
    if (first === null) first = start = now;
    peak = Math.max(peak, rms);
    n++;
    if (rms > VOICE_RMS) loud++, (everLoud = true);
    if (now - start < windowMs) return null;
    const line = `mic peakRms=${Math.round(peak)} voice=${loud}/${n}`;
    const warn = !everLoud && !warned && now - first >= warnMs;
    if (warn) warned = true;
    start = now, peak = loud = n = 0;
    return { line, warn };
  };
}

// Nearest-rank percentile, p in 0..100.
export function pct(values, p) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ms since t, or "-" when t was never set (0): a typed or hook turn before any voice.
export const ago = (now, t) => (t ? now - t : "-");
