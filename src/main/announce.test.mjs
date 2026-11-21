import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LINES, clipPath, createAnnouncer, matches, trim } from "./announce.mjs";

const pcm = (samples) => { const b = Buffer.alloc(samples.length * 2); samples.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "announce-"));

test("clip path: model without models/, voice, key; no way out of the folder", () => {
  assert.equal(clipPath("/h", "models/gemini-3.8-live", "Zephyr", "vision-on"), path.join("/h", "announce", "gemini-3.8-live", "Zephyr", "vision-on.pcm"));
  assert.equal(clipPath("/h", "models/../../x", "../y", "k"), path.join("/h", "announce", "x", "y", "k.pcm"));
});

test("match ignores case, punctuation and spaces, not words", () => {
  assert.ok(matches(" Hand  control, on. ", "Hand control on"));
  assert.ok(!matches("Hand control is on", "Hand control on"));
  assert.ok(!matches("", "Hand control on"));
});

test("trim cuts silence at both ends and keeps a short pad", () => {
  const out = trim(pcm([...Array(5000).fill(0), 1000, -2000, 1000, ...Array(5000).fill(10)]), 300, 1); // 1 ms pad = 24 samples
  assert.equal(out.length / 2, 3 + 2 * 24);
  assert.equal(trim(pcm(Array(100).fill(5))).length, 0);
});

test("missing clip: null and a log line, no throw", () => {
  const logs = [];
  const a = createAnnouncer({ home: tmp(), log: (...l) => logs.push(l.join(" ")), say: async () => ({}) });
  assert.equal(a.clip("models/m", "V", "listen-on"), null);
  assert.match(logs[0], /announce missing listen-on/);
});

test("ensure: makes all six, retries twice, keeps the last try on mismatch, skips existing clips", async () => {
  const home = tmp(), logs = [], calls = [];
  const loud = pcm([0, 0, 900, 900, 0, 0]);
  const say = async (model, voice, line) => {
    calls.push(line);
    if (line === LINES["vision-on"]) return { pcm: loud, said: "Hand vision on" }; // always wrong
    if (line === LINES["control-off"]) return { pcm: Buffer.alloc(0), said: "", err: "timeout" }; // never any audio
    return { pcm: loud, said: line };
  };
  const a = createAnnouncer({ home, log: (...l) => logs.push(l.join(" ")), say });
  await Promise.all([a.ensure("models/m", "V"), a.ensure("models/m", "V")]); // the second call joins the first
  assert.equal(calls.filter((l) => l === LINES["vision-on"]).length, 3);
  assert.equal(calls.length, 4 * 1 + 3 + 3);
  assert.ok(a.clip("models/m", "V", "vision-on"), "mismatch keeps the last try");
  assert.ok(logs.some((l) => /announce mismatch vision-on/.test(l)));
  assert.ok(!fs.existsSync(clipPath(home, "models/m", "V", "control-off")));
  assert.ok(logs.some((l) => /generate failed control-off: timeout/.test(l)));
  calls.length = 0;
  await a.ensure("models/m", "V");
  assert.deepEqual(calls, Array(3).fill(LINES["control-off"]), "only the missing clip is made again");
});
