// Pure gesture math on MediaPipe hand landmarks (21 points, x/y normalized 0..1, z = depth from the wrist on about the x scale).
// Shared by the renderer and hand.test.mjs.

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)); // test fixtures are 2D
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Cursor follows the index knuckle (5), not the fingertip: the knuckle barely moves when you pinch, so clicks don't drift.
// `span`: the centred share of the camera frame that maps to the whole screen. Smaller = less arm travel, more jitter.
export function cursorFrom(lm, span = 0.6) {
  const p = lm[5];
  const map = (v) => clamp01((v - (1 - span) / 2) / span);
  return { x: map(1 - p.x), y: map(p.y) }; // mirror x so moving your hand right moves the cursor right
}

// One Euro filter (Casiez 2012): heavy smoothing when the hand is still (kills jitter), light when it moves fast (no lag).
// t in ms. minCutoff (Hz): lower = steadier at rest. beta: higher = less lag when moving. Speeds are screen widths/s.
export function smooth(prev, next, t, minCutoff = 0.7, beta = 10) {
  if (!prev?.t || t <= prev.t) return { x: next.x, y: next.y, vx: 0, vy: 0, t };
  const dt = (t - prev.t) / 1000;
  const alpha = (cutoff) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  const av = alpha(1);
  const vx = prev.vx + av * ((next.x - prev.x) / dt - prev.vx);
  const vy = prev.vy + av * ((next.y - prev.y) / dt - prev.vy);
  const a = alpha(minCutoff + beta * Math.hypot(vx, vy));
  return { x: prev.x + a * (next.x - prev.x), y: prev.y + a * (next.y - prev.y), vx, vy, t };
}

// Thumb tip (4) to a fingertip (8 index = left button, 12 middle = right click), scaled by hand size (wrist 0 → middle knuckle 9) so distance from camera doesn't matter.
// Two thresholds (hysteresis) so a pinch near the edge doesn't flicker down/up.
// 3D: a hand turned sideways puts the thumb tip over a fingertip in the image while they are still apart in depth.
// `flat` = the old 2D ratio, only for the log that compares the two.
export function pinchRatio(lm, tip = 8, flat = false) {
  const d = flat ? dist : dist3;
  return d(lm[4], lm[tip]) / d(lm[0], lm[9]);
}

export const PINCH_ON = 0.25; // was 0.30/0.45: fingers visibly apart still counted as pinched
const PINCH_OFF = 0.33;
export function isPinched(lm, wasPinched, tip = 8) {
  const d = pinchRatio(lm, tip);
  return wasPinched ? d < PINCH_OFF : d < PINCH_ON;
}

// 0 = fingers relaxed apart (ratio ≥ 0.6), 1 = at the pinch threshold. Drives the shrinking ring.
export const pinchApproach = (ratio) => clamp01((0.6 - ratio) / (0.6 - PINCH_ON));

// A finger is extended when its tip is farther from the wrist than its middle joint.
const extended = (lm, tip, pip) => dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]);

// "V" pose (index + middle up, ring + pinky folded) switches to scroll mode.
export const isScrollPose = (lm) =>
  extended(lm, 8, 6) && extended(lm, 12, 10) && !extended(lm, 16, 14) && !extended(lm, 20, 18);

// Trackpad mode: the cursor moves by the hand's motion (from → to, filtered hand points with t in ms), not its position.
// Slow hand = ~1.5x (precise), fast hand = up to 5x (cross a big screen with a flick). Speeds in camera frames/s.
export function trackpad(cursor, from, to) {
  if (!from) return cursor; // hand just (re)appeared or was lifted: no jump
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const gain = Math.min(5, 1.5 + 1.5 * (Math.hypot(dx, dy) / ((to.t - from.t) / 1000 || 1)));
  return { x: clamp01(cursor.x + dx * gain), y: clamp01(cursor.y + dy * gain) };
}

// Scroll inertia: after the V pose ends, keep scrolling at the last speed (px per frame) and slow down to a stop.
export const GLIDE_MIN = 30; // slower than this when the pose ends = no glide, so slow precise scrolling stops dead
export function glide(v, decay = 0.92) {
  const n = { x: v.x * decay, y: v.y * decay };
  return Math.hypot(n.x, n.y) < 1 ? null : n;
}

// Fist (all four fingers folded) = lift: the cursor stays put (trackpad mode: move the hand back without moving it).
// Open ✋: all four fingers up and the thumb clear of index and middle (a pinch is not open). Two of these = gallery zoom.
export const isOpen = (lm) =>
  [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => extended(lm, tip, pip)) && pinchRatio(lm, 8) > PINCH_OFF && pinchRatio(lm, 12) > PINCH_OFF;

// Two-hand zoom (HUD gallery viewer): both palms (middle knuckle 9, mirrored like the screen), or null unless exactly
// two hands are seen and both are open ✋.
export const palmsOf = (hands) => (hands.length === 2 && hands.every(isOpen) ? hands.map((l) => ({ x: 1 - l[9].x, y: l[9].y })) : null);
// Zoom follows the palm gap: `grab` = { dist, zoom } when the two hands appeared. Hands twice as far apart = twice the zoom.
export const palmGap = (palms) => dist(palms[0], palms[1]);
export const zoomTarget = (grab, gap, max) => Math.max(1, Math.min(max, (grab.zoom * gap) / grab.dist));

export const isFist = (lm) => [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => !extended(lm, tip, pip));

// Rock 🤘 (index + pinky up, middle + ring folded), held LOCK_HOLD_MS, toggles control. Unusual on purpose: never by accident.
export const LOCK_HOLD_MS = 1500;
export const isRock = (lm) => extended(lm, 8, 6) && !extended(lm, 12, 10) && !extended(lm, 16, 14) && extended(lm, 20, 18);

// Thumbs up 👍 (four fingers folded, thumb tip well above the index knuckle), held LOCK_HOLD_MS, toggles listen-only.
// Checked before isFist, which ignores the thumb. A normal fist tucks the thumb below the knuckle, so it never counts.
// Palm toward the camera: cosine between the palm's normal (wrist 0, index knuckle 5, pinky knuckle 17) and the camera axis.
// 1 = palm (or back) square to the camera, 0 = hand edge-on. Signed; which sign is the palm depends on the hand, so the
// gate uses the size only. shortcut: back of the hand also passes, add the sign per hand if the log shows back-hand clicks.
export function palmFacing(lm) {
  const a = { x: lm[5].x - lm[0].x, y: lm[5].y - lm[0].y, z: (lm[5].z ?? 0) - (lm[0].z ?? 0) };
  const b = { x: lm[17].x - lm[0].x, y: lm[17].y - lm[0].y, z: (lm[17].z ?? 0) - (lm[0].z ?? 0) };
  const n = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  return n.z / (Math.hypot(n.x, n.y, n.z) || 1);
}
export const FACING_MIN = 0.5; // up to ~60° turned still clicks; hardware calibration, tune from the "gesture" log lines
export const isFacing = (lm) => Math.abs(palmFacing(lm)) >= FACING_MIN;

export const isThumbUp = (lm) => isFist(lm) && dist(lm[4], lm[0]) > dist(lm[3], lm[0]) && (lm[5].y - lm[4].y) / dist(lm[0], lm[9]) > 0.35;

// Click lock: while pinched, and for `hold` ms after letting go, the cursor stays on the click point unless the hand
// moves past `radius` (screen fraction). Hand jitter otherwise turns a click into a drag and breaks double-clicks.
export const CLICK_HOLD_MS = 500; // macOS default double-click interval
export function clickLock(anchor, cursor, now, radius = 0.025) {
  if (!anchor || now > anchor.until) return null;
  return Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y) < radius ? anchor : null;
}

// Pose debounce: the model misreads a held ✌ as ✋/🤏/✊ for single frames (~30-70ms), and each misread frame
// used to fall into the click branch. Switch only after the new pose is seen POSE_FRAMES frames in a row.
// s = { pose, next, count } from the previous frame, null after the hand was lost (then the first pose is taken as is).
// Gallery ring (hud-ui.js). `turned` = cards turned, fractional while ✌ scrolls, not wrapped so it never spins the long way.
// Under RING_SLOTS cards a full circle puts them back to back (2 cards = front + one hidden behind), so few cards sit on
// an arc of RING_SLOTS-sized steps instead, and turning stops at the ends.
export const RING_SLOTS = 6;
export const ringTurn = (turned, d, n) => (n < RING_SLOTS ? Math.max(0, Math.min(n - 1, turned + d)) : turned + d);
export const ringFront = (turned, n) => ((Math.round(turned) % n) + n) % n;
// How far to turn to bring card i to the front: straight there on an arc, the shortest way round on a ring.
export function ringTo(turned, i, n) {
  if (n < RING_SLOTS) return i - turned;
  let d = (i - ringFront(turned, n) + n) % n;
  if (d > n / 2) d -= n;
  return d;
}

export const POSE_FRAMES = 3; // ~100ms at 33ms frames
export function settle(s, raw, frames = POSE_FRAMES) {
  if (!s || raw === s.pose) return { pose: raw, next: raw, count: 0 };
  const count = raw === s.next ? s.count + 1 : 1;
  return count >= frames ? { pose: raw, next: raw, count: 0 } : { pose: s.pose, next: raw, count };
}

// ✌ scroll deadzone: the anchor stays put until the knuckle has moved SCROLL_DEAD of the frame, so camera noise on a
// still hand (~0.002 → ±4px at gain 2000, flipping sign) scrolls nothing; a real move is sent whole once past it.
export const SCROLL_DEAD = 0.006;
export function scrollStep(anchor, p, dead = SCROLL_DEAD) {
  if (!anchor) return { d: { x: 0, y: 0 }, anchor: p };
  const d = { x: p.x - anchor.x, y: p.y - anchor.y };
  return Math.hypot(d.x, d.y) < dead ? { d: { x: 0, y: 0 }, anchor } : { d, anchor: p };
}
