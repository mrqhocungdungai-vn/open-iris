import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, deafWatch, micMeter, pct, rms16, VOICE_RMS } from "./perf.mjs";

test("rms16 of silence, a full-scale square wave, and an empty buffer", () => {
  assert.equal(rms16(Buffer.alloc(320)), 0);
  const sq = Buffer.alloc(8);
  [32767, -32767, 32767, -32767].forEach((v, i) => sq.writeInt16LE(v, i * 2));
  assert.equal(rms16(sq), 32767);
  assert.equal(rms16(Buffer.alloc(0)), 0);
});

test("pct uses nearest rank and does not reorder its input", () => {
  const v = [5, 1, 4, 2, 3];
  assert.equal(pct(v, 50), 3);
  assert.equal(pct(v, 95), 5);
  assert.equal(pct(v, 0), 1);
  assert.deepEqual(v, [5, 1, 4, 2, 3]);
  assert.ok(Number.isNaN(pct([], 50)));
});

test("ago gives a duration, or - when nothing was marked (no epoch value)", () => {
  assert.equal(ago(1500, 1000), 500);
  assert.equal(ago(1795157605276, 0), "-");
});

test("micMeter: one line per 5 s window, and one warn when 30 s of mic never reached voice level", () => {
  const m = micMeter();
  const out = [];
  for (let t = 0; t <= 40000; t += 8) { const r = m(VOICE_RMS / 10, t); if (r) out.push(r); }
  assert.equal(out.length, 8);
  assert.equal(out[0].line, `mic peakRms=${VOICE_RMS / 10} voice=0/626`);
  assert.deepEqual(out.map((o) => o.warn), [false, false, false, false, false, true, false, false]); // once, at 30 s
  const loud = micMeter();
  let warned = false;
  loud(VOICE_RMS * 2, 0); // someone spoke once
  for (let t = 8; t <= 40000; t += 8) warned ||= loud(0, t)?.warn ?? false;
  assert.equal(warned, false);
  assert.match(micMeter()(0, 0) ?? "none", /none/); // first chunk opens the window
});


// 8 ms chunks of 256 bytes from t=1; returns the times the watch fired.
const talk = (w, ms, rms = VOICE_RMS * 2, from = 1) => {
  const fired = [];
  for (let t = from; t < from + ms; t += 8) if (w.feed(256, rms, t)) fired.push(t);
  return fired;
};

test("deafWatch fires once, at 10 s after the first voice when 4 s of it got no transcript", () => {
  assert.deepEqual(talk(deafWatch(), 30000), [10001]);
  const w = deafWatch();
  assert.deepEqual(talk(w, 3000), []); // 3 s of voice ...
  assert.deepEqual(talk(w, 7000, 0, 3001), []); // ... then silence: not enough voice yet
  assert.deepEqual(talk(w, 1000, VOICE_RMS * 2, 10001), [10993]); // 4 s of voice reached
});

test("deafWatch never fires after a transcript, on silence, or with no chunks (muted)", () => {
  const w = deafWatch();
  talk(w, 2000);
  w.heard();
  assert.deepEqual(talk(w, 30000, VOICE_RMS * 2, 2001), []);
  assert.deepEqual(talk(deafWatch(), 60000, VOICE_RMS), []); // at the threshold is not voice
  assert.deepEqual(talk(deafWatch(), 0), []); // muted: main.mjs never calls feed
});
