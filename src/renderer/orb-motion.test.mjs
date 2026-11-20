import { test } from "node:test";
import assert from "node:assert/strict";
import { PALETTES, SILENCE_MS, THINKING_TIMEOUT_MS, levelFromRms, newOrb, newThinking, noise, orbState, settled, smoothLevel, stepOrb, thinkingStep, toolCall } from "./orb-motion.mjs";

const run = (s, input, seconds, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) stepOrb(s, input, dt);
  return s;
};

test("orbState maps status, listen-only and thinking to the 5 looks", () => {
  assert.equal(orbState({ status: "offline" }), "offline");
  assert.equal(orbState({ status: "connecting", thinking: true }), "offline");
  assert.equal(orbState({ status: "listening" }), "listening");
  assert.equal(orbState({ status: "listening", thinking: true }), "thinking");
  assert.equal(orbState({ status: "speaking", thinking: true }), "speaking");
  assert.equal(orbState({ status: "speaking", listenOnly: true }), "listenOnly");
});

test("smoothLevel rises fast and falls slowly", () => {
  const up = smoothLevel(0, 1, 0.05);
  const down = 1 - smoothLevel(1, 0, 0.05);
  assert.ok(up > 0.7, `attack ${up}`);
  assert.ok(down < 0.3, `release ${down}`);
});

test("levelFromRms clamps to 0..1", () => {
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(1), 1);
  assert.ok(Math.abs(levelFromRms(0.05) - 0.3) < 1e-9);
});

test("noise stays in 0..1 and is deterministic", () => {
  for (let x = -5; x < 5; x += 0.37) {
    const n = noise(x);
    assert.ok(n >= 0 && n <= 1);
    assert.equal(n, noise(x));
  }
});

test("stepOrb eases colour and energy to the state's palette", () => {
  const s = run(newOrb("offline"), { state: "speaking" }, 3);
  assert.ok(Math.abs(s.energy - PALETTES.speaking.e) < 0.01);
  assert.ok(s.c.every((v, i) => Math.abs(v - PALETTES.speaking.c[i]) < 2));
});

test("mic level shows while listening, half in listen-only, never offline", () => {
  assert.ok(run(newOrb("listening"), { state: "listening", inL: 0.8 }, 1).inL > 0.75);
  const half = run(newOrb("listenOnly"), { state: "listenOnly", inL: 0.8 }, 1).inL;
  assert.ok(Math.abs(half - 0.4) < 0.05, `listen-only ${half}`);
  assert.equal(run(newOrb(), { state: "offline", inL: 0.8 }, 1).inL, 0);
});

test("output level only drives the orb while Iris speaks", () => {
  assert.ok(run(newOrb("speaking"), { state: "speaking", outL: 0.6 }, 1).outL > 0.55);
  assert.ok(run(newOrb("listening"), { state: "listening", outL: 0.6 }, 1).outL < 0.001);
});

test("rings spin when live, stand still offline or with reduced motion", () => {
  assert.ok(run(newOrb("listening"), { state: "listening" }, 1).r1 > 0.5);
  assert.equal(run(newOrb(), { state: "offline" }, 1).r1, 0);
  assert.equal(run(newOrb("listening"), { state: "listening", reduce: true }, 1).r1, 0);
});

test("settled is false mid-transition and true once the offline look is reached", () => {
  const s = run(newOrb("speaking"), { state: "speaking", outL: 0.5 }, 0.5);
  assert.equal(settled(s, "offline"), false);
  assert.equal(settled(run(s, { state: "offline" }, 4), "offline"), true);
});

test("silence after speech opens thinking; speaking or loud speech closes it", () => {
  let t = newThinking();
  t = thinkingStep(t, { level: 0.5, speaking: false, now: 0 });
  t = thinkingStep(t, { level: 0, speaking: false, now: SILENCE_MS - 100 });
  assert.equal(t.thinking, false, "a short pause is not a finished question");
  t = thinkingStep(t, { level: 0, speaking: false, now: SILENCE_MS + 10 });
  assert.equal(t.thinking, true);
  assert.equal(thinkingStep(t, { level: 0, speaking: true, now: 600 }).thinking, false);
  assert.equal(thinkingStep(t, { level: 0.5, speaking: false, now: 600 }).thinking, false);
});

test("thinking never opens without speech and gives up after the timeout", () => {
  assert.equal(thinkingStep(newThinking(), { level: 0, speaking: false, now: 5000 }).thinking, false);
  let t = toolCall(newThinking(), 1000);
  assert.equal(t.thinking, true);
  t = thinkingStep(t, { level: 0, speaking: false, now: 1000 + THINKING_TIMEOUT_MS - 1 });
  assert.equal(t.thinking, true);
  t = thinkingStep(t, { level: 0, speaking: false, now: 1000 + THINKING_TIMEOUT_MS + 1 });
  assert.equal(t.thinking, false);
});
