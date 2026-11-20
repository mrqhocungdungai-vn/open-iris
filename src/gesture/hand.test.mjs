import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorFrom, smooth, isPinched, isScrollPose, glide, settle, ringTurn, ringFront, ringTo, scrollStep } from "./hand.js";

// Build a 21-point hand: wrist at (0.5,0.8), middle knuckle 0.2 above it, thumb/index tips `gap` apart.
const hand = ({ knuckle = { x: 0.5, y: 0.5 }, gap = 0.2 } = {}) => {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.8 };
  lm[9] = { x: 0.5, y: 0.6 };
  lm[5] = knuckle;
  lm[4] = { x: 0.5, y: 0.4 };
  lm[8] = { x: 0.5 + gap, y: 0.4 };
  return lm;
};

test("cursor is mirrored and the frame edge zone clamps to screen edges", () => {
  assert.deepEqual(cursorFrom(hand({ knuckle: { x: 0.5, y: 0.5 } })), { x: 0.5, y: 0.5 });
  assert.deepEqual(cursorFrom(hand({ knuckle: { x: 0.9, y: 0.05 } })), { x: 0, y: 0 });
  assert.deepEqual(cursorFrom(hand({ knuckle: { x: 0.1, y: 0.95 } })), { x: 1, y: 1 });
});

test("smooth: still hand with jitter stays put, fast move keeps up", () => {
  let c = null;
  for (let i = 0; i < 60; i++) c = smooth(c, { x: 0.5 + (i % 2 ? 0.01 : -0.01), y: 0.5 }, i * 33);
  assert.ok(Math.abs(c.x - 0.5) < 0.003, `jitter left ${c.x}`); // ±1% noise → under 0.3%
  c = null;
  for (let i = 0; i < 30; i++) c = smooth(c, { x: i * 0.03, y: 0.5 }, i * 33); // ~1 screen/s
  assert.ok(29 * 0.03 - c.x < 0.06, `lag ${29 * 0.03 - c.x}`); // trails by under 6% of the screen
});

test("pinch uses hysteresis", () => {
  assert.equal(isPinched(hand({ gap: 0.02 }), false), true); // 0.1 hand-sizes: pinched
  assert.equal(isPinched(hand({ gap: 0.06 }), false), false); // 0.3: not yet
  assert.equal(isPinched(hand({ gap: 0.06 }), true), true); // 0.3: stays pinched
  assert.equal(isPinched(hand({ gap: 0.08 }), true), false); // 0.4: fingers apart, released
});

test("pinch works with the middle finger for right click", () => {
  const lm = hand({ gap: 0.2 });
  lm[12] = { x: 0.51, y: 0.4 };
  assert.equal(isPinched(lm, false, 12), true);
  assert.equal(isPinched(lm, false, 8), false);
});

test("scroll pose is index + middle up, ring + pinky folded", () => {
  const lm = hand();
  const finger = (tip, pip, up) => {
    lm[pip] = { x: 0.5, y: 0.6 };
    lm[tip] = { x: 0.5, y: up ? 0.4 : 0.7 }; // folded tip curls back toward the wrist
  };
  finger(8, 6, true); finger(12, 10, true); finger(16, 14, false); finger(20, 18, false);
  assert.equal(isScrollPose(lm), true);
  finger(16, 14, true); // open palm is not scroll
  assert.equal(isScrollPose(lm), false);
});

test("click lock holds the cursor on the click point until the hand moves away or time runs out", async () => {
  const { clickLock } = await import("./hand.js");
  const a = { x: 0.5, y: 0.5, until: 1000 };
  assert.equal(clickLock(a, { x: 0.51, y: 0.5 }, 500), a); // jitter: stay put
  assert.equal(clickLock(a, { x: 0.6, y: 0.5 }, 500), null); // real move: start dragging / follow the hand
  assert.equal(clickLock(a, { x: 0.5, y: 0.5 }, 1001), null); // double-click window over
  assert.equal(clickLock(null, { x: 0.5, y: 0.5 }, 0), null);
});

test("a smaller span reaches the screen edge with less hand travel", () => {
  assert.deepEqual(cursorFrom(hand({ knuckle: { x: 0.75, y: 0.25 } }), 0.4), { x: 0, y: 0 });
  assert.equal(cursorFrom(hand({ knuckle: { x: 0.75, y: 0.25 } }), 0.6).x > 0, true);
});

test("fist is all four fingers folded; V pose and open hand are not", async () => {
  const { isFist } = await import("./hand.js");
  const lm = hand();
  const finger = (tip, pip, up) => { lm[pip] = { x: 0.5, y: 0.6 }; lm[tip] = { x: 0.5, y: up ? 0.4 : 0.7 }; };
  [[8, 6], [12, 10], [16, 14], [20, 18]].forEach(([t, p]) => finger(t, p, false));
  assert.equal(isFist(lm), true);
  finger(8, 6, true);
  assert.equal(isFist(lm), false);
});

test("open ✋ is all four fingers up with the thumb away; fist and pinch are not", async () => {
  const { isOpen } = await import("./hand.js");
  const lm = hand();
  const finger = (tip, pip, up) => { lm[pip] = { x: 0.5, y: 0.6 }; lm[tip] = { x: 0.5, y: up ? 0.4 : 0.7 }; };
  const all = (up) => [[8, 6], [12, 10], [16, 14], [20, 18]].forEach(([t, p]) => finger(t, p, up));
  all(true);
  lm[4] = { x: 0.9, y: 0.5 }; // thumb out to the side
  assert.equal(isOpen(lm), true);
  lm[4] = { ...lm[8] }; // thumb on the index tip = pinch
  assert.equal(isOpen(lm), false);
  lm[4] = { x: 0.9, y: 0.5 };
  all(false); // fist
  assert.equal(isOpen(lm), false);
});

test("pinchApproach goes 0 → 1 as the fingers close to the pinch threshold", async () => {
  const { pinchApproach } = await import("./hand.js");
  assert.equal(pinchApproach(0.8), 0);
  assert.equal(pinchApproach(0.25), 1);
  assert.equal(pinchApproach(0.1), 1);
  assert.ok(Math.abs(pinchApproach(0.425) - 0.5) < 1e-9);
});

test("trackpad: moves by hand motion, faster hands go further, no jump after a lift", async () => {
  const { trackpad } = await import("./hand.js");
  const c = { x: 0.5, y: 0.5 };
  assert.deepEqual(trackpad(c, null, { x: 0.9, y: 0.9, t: 0 }), c); // lifted: stays
  const slow = trackpad(c, { x: 0.5, y: 0.5, t: 0 }, { x: 0.51, y: 0.5, t: 100 }); // 0.1 frames/s
  const fast = trackpad(c, { x: 0.5, y: 0.5, t: 0 }, { x: 0.6, y: 0.5, t: 33 }); // 3 frames/s
  assert.ok((slow.x - 0.5) / 0.01 < 2, "slow ≈ 1.5x");
  assert.ok((fast.x - 0.5) / 0.1 > 4, "fast ≈ 5x");
  assert.equal(trackpad({ x: 0.99, y: 0.5 }, { x: 0.5, y: 0.5, t: 0 }, { x: 0.6, y: 0.5, t: 33 }).x, 1); // clamped to screen
});

test("rock 🤘 is index + pinky up only; fist, V and open hand are not", async () => {
  const { isRock, isFist } = await import("./hand.js");
  const lm = hand();
  const finger = (tip, pip, up) => { lm[pip] = { x: 0.5, y: 0.6 }; lm[tip] = { x: 0.5, y: up ? 0.4 : 0.7 }; };
  const pose = (i, m, r, p) => { finger(8, 6, i); finger(12, 10, m); finger(16, 14, r); finger(20, 18, p); };
  pose(true, false, false, true);
  assert.equal(isRock(lm), true);
  assert.equal(isFist(lm), false);
  pose(true, true, false, false); // V
  assert.equal(isRock(lm), false);
  pose(false, false, false, false); // fist
  assert.equal(isRock(lm), false);
  pose(true, true, true, true); // open
  assert.equal(isRock(lm), false);
});

test("thumbs up 👍 is a fist with the thumb pointing up; a tucked thumb or open hand is not", async () => {
  const { isThumbUp, isFist } = await import("./hand.js");
  const lm = hand({ knuckle: { x: 0.5, y: 0.6 } });
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) { lm[pip] = { x: 0.5, y: 0.6 }; lm[tip] = { x: 0.5, y: 0.7 }; }
  lm[3] = { x: 0.5, y: 0.5 };
  lm[4] = { x: 0.5, y: 0.4 }; // thumb up, 1 hand size above the knuckle
  assert.equal(isThumbUp(lm), true);
  assert.equal(isFist(lm), true); // why the engine checks 👍 first
  lm[4] = { x: 0.55, y: 0.62 }; // thumb tucked over the fingers = plain fist
  assert.equal(isThumbUp(lm), false);
  lm[4] = { x: 0.5, y: 0.4 };
  lm[8] = { x: 0.5, y: 0.3 }; // index up: not folded
  assert.equal(isThumbUp(lm), false);
});

test("two-hand zoom: only two open hands count, zoom follows the palm gap within 1×..max", async () => {
  const { palmsOf, palmGap, zoomTarget } = await import("./hand.js");
  const open = (x) => {
    const lm = Array.from({ length: 21 }, () => ({ x, y: 0.5 }));
    lm[0] = { x, y: 0.8 };
    lm[9] = { x, y: 0.6 };
    lm[4] = { x: x - 0.2, y: 0.6 }; // thumb out to the side: not a pinch
    for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) { lm[pip] = { x, y: 0.6 }; lm[tip] = { x, y: 0.4 }; }
    return lm;
  };
  const fist = (x) => { const lm = open(x); for (const tip of [8, 12, 16, 20]) lm[tip] = { x, y: 0.7 }; return lm; };
  assert.deepEqual(palmsOf([open(0.25), open(0.75)]), [{ x: 0.75, y: 0.6 }, { x: 0.25, y: 0.6 }]); // mirrored
  assert.equal(palmsOf([open(0.3)]), null); // one hand
  assert.equal(palmsOf([open(0.3), fist(0.7)]), null); // one hand closed
  assert.equal(palmsOf([open(0.2), open(0.5), open(0.8)]), null);

  const grab = { dist: 0.2, zoom: 1 };
  assert.ok(Math.abs(palmGap([{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }]) - 0.4) < 1e-9);
  assert.equal(zoomTarget(grab, 0.4, 6), 2); // apart ×2 = zoom in ×2
  assert.equal(zoomTarget(grab, 0.1, 6), 1); // together: never below 1×
  assert.equal(zoomTarget(grab, 2, 6), 6); // capped at max
  assert.equal(zoomTarget({ dist: 0.5, zoom: 3 }, 0.25, 6), 1.5); // grabbed at 3×, half the gap = zoom out
});

test("glide slows down and stops within ~2s", () => {
  let v = { x: 0, y: 100 };
  let frames = 0;
  while (v && frames < 200) { v = glide(v); frames++; }
  assert.equal(v, null);
  assert.ok(frames > 20 && frames < 70, `${frames} frames`); // 33ms frames
});

test("settle ignores single misread frames, switches after 3 in a row", () => {
  let s = settle(null, "scroll");
  for (const raw of ["move", "scroll", "fist", "move", "scroll"]) s = settle(s, raw); // flicker while holding ✌
  assert.equal(s.pose, "scroll");
  for (let i = 0; i < 2; i++) s = settle(s, "move");
  assert.equal(s.pose, "scroll");
  s = settle(s, "move");
  assert.equal(s.pose, "move");
});

test("gallery ring: few cards stop at the arc ends, many wrap the shortest way", () => {
  assert.equal(ringTurn(0, -0.5, 3), 0); // arc: no turning past the first card
  assert.equal(ringTurn(1.8, 1, 3), 2); // …or the last
  assert.equal(ringTurn(0, -0.5, 8), -0.5); // ring: keeps going
  assert.equal(ringFront(-0.6, 8), 7); // snaps to the nearest card, wrapped
  assert.equal(ringTo(0, 7, 8), -1); // card 7 of 8 is one step back, not seven forward
  assert.equal(ringTo(0.4, 2, 3), 1.6); // arc: straight to the card
});

test("✌ scroll: a still hand with camera jitter scrolls nothing, a real move still scrolls", () => {
  let s = scrollStep(null, { x: 0.5, y: 0.5 });
  let sent = 0;
  for (let i = 0; i < 60; i++) {
    s = scrollStep(s.anchor, { x: 0.5 + (i % 2 ? 0.002 : -0.002), y: 0.5 + (i % 3 - 1) * 0.0025 });
    sent += Math.hypot(s.d.x, s.d.y);
  }
  assert.equal(sent, 0);
  let moved = 0;
  for (let i = 1; i <= 10; i++) {
    s = scrollStep(s.anchor, { x: 0.5, y: 0.5 + i * 0.01 }); // 1% of the frame per frame: a slow, real scroll
    moved += s.d.y;
  }
  assert.ok(moved > 0.09);
});
