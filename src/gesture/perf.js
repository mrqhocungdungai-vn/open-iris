// [perf] summary of one window of hand tracking (docs/optimize-plan.md §2: H1 FPS, H3 latency and jitter).
import { pct } from "../main/perf.mjs";

const sd = (v) => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
};
const r1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : "-");

// w: { cam, ticks, dup, detect: ms[], lat: ms[], cur: {x,y}[], raw: {x,y}[] }, points 0..1; secs: window length; px: screen width.
// Jitter = standard deviation of the point over the window, in screen px: only meaningful while the hand is held still.
export function handPerfLine(w, secs, px, src) {
  const jit = (pts) => (pts.length > 1 ? Math.hypot(sd(pts.map((p) => p.x)), sd(pts.map((p) => p.y))) * px : NaN);
  return `[perf] hand cam=${r1(w.cam / secs)}fps detect=${r1(w.ticks / secs)}fps sameFrame=${w.dup}`
    + ` detectMs p50=${r1(pct(w.detect, 50))} p95=${r1(pct(w.detect, 95))}`
    + ` lat(${src}) p50=${r1(pct(w.lat, 50))} p95=${r1(pct(w.lat, 95))}ms`
    + ` jitter cursor=${r1(jit(w.cur))}px raw=${r1(jit(w.raw))}px n=${w.cur.length}`;
}
