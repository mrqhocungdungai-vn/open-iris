import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, pct, rms16 } from "./perf.mjs";

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
