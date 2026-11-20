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

// Nearest-rank percentile, p in 0..100.
export function pct(values, p) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

// ms since t, or "-" when t was never set (0): a typed or hook turn before any voice.
export const ago = (now, t) => (t ? now - t : "-");
