// System announcements (docs/system-announce-plan.md): six fixed English lines, spoken outside the conversation.
// Each clip is made once by a separate Live session (same model and voice as Iris), checked against its transcript,
// trimmed and cached in ~/.open-iris/announce/<model>/<voice>/<key>.pcm (24 kHz s16 mono). No clip yet: silent.
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

export const LINES = { "vision-on": "Hand Task Vision enabled", "vision-off": "Hand Task Vision disabled", "control-on": "Hand control on", "control-off": "Hand control off", "listen-on": "Listen mode active", "listen-off": "Listen mode inactive" };
export const RATE = 24000;
const TRIES = 3; // the first try and 2 retries

export const clipPath = (home, model, voice, key) => path.join(home, "announce", path.basename(String(model).replace(/^models\//, "")), path.basename(String(voice)), `${key}.pcm`);
export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
export const matches = (said, line) => norm(said) === norm(line);

// Cuts leading and trailing silence (s16 LE), keeping a short pad so the first and last sounds are not clipped.
export function trim(pcm, threshold = 300, padMs = 40) {
  const n = pcm.length >> 1;
  const loud = (i) => Math.abs(pcm.readInt16LE(i * 2)) >= threshold;
  let a = 0, b = n - 1;
  while (a < n && !loud(a)) a++;
  if (a === n) return pcm.subarray(0, 0);
  while (!loud(b)) b--;
  const pad = Math.round((RATE * padMs) / 1000);
  return pcm.subarray(Math.max(0, a - pad) * 2, Math.min(n, b + 1 + pad) * 2);
}

// One Live session that speaks one line: resolves { pcm, said, err } and never rejects.
export function sayLine(apiKey, model, voice, line) {
  return new Promise(async (done) => {
    const chunks = [];
    let said = "", s, ended = false;
    const finish = (err) => { if (ended) return; ended = true; clearTimeout(timer); try { s?.close(); } catch {} done({ err, pcm: Buffer.concat(chunks), said }); };
    const timer = setTimeout(() => finish("timeout"), 20000);
    try {
      s = await new GoogleGenAI({ apiKey }).live.connect({
        model,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: "You read system announcements aloud. Say exactly the words you are given, once, with nothing before or after." }] },
        },
        callbacks: {
          onmessage: (m) => {
            const c = m.serverContent;
            for (const p of c?.modelTurn?.parts || []) if (p.inlineData?.data) chunks.push(Buffer.from(p.inlineData.data, "base64"));
            if (c?.outputTranscription?.text) said += c.outputTranscription.text;
            if (c?.turnComplete) finish(null);
          },
          onclose: (e) => finish(e?.code === 1000 ? null : `close ${e?.code} ${e?.reason || ""}`.trim()),
        },
      });
      s.sendRealtimeInput({ text: `Say exactly: ${line}` });
    } catch (e) { finish(e?.message || "connect failed"); }
  });
}

// say(model, voice, line) is sayLine with the key bound; tests pass a fake.
export function createAnnouncer({ home, log, say }) {
  const running = new Map(); // "<model>/<voice>" -> promise, so a second call joins the first

  async function make(model, voice) {
    for (const [key, line] of Object.entries(LINES)) {
      const file = clipPath(home, model, voice, key);
      if (fs.existsSync(file)) continue;
      let r;
      for (let i = 0; i < TRIES; i++) {
        r = await say(model, voice, line);
        if (!r.err && matches(r.said, line)) break;
      }
      const pcm = trim(r.pcm);
      if (!pcm.length) { log("WARN", "announce", `generate failed ${key}: ${r.err || "no audio"}`); continue; } // next launch tries again
      if (r.err || !matches(r.said, line)) log("WARN", "announce", `mismatch ${key}: said "${r.said.trim()}"`); // kept: still the right voice
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", pcm);
      fs.renameSync(file + ".tmp", file);
      log("INFO", "announce", `clip ${key} ${(pcm.length / 2 / RATE).toFixed(2)}s model=${model} voice=${voice}`);
    }
  }

  return {
    // Makes the missing clips for this model and voice in the background.
    ensure(model, voice) {
      const id = `${model}/${voice}`;
      if (!running.has(id)) running.set(id, make(model, voice).catch((e) => log("ERROR", "announce", e?.message || String(e))).finally(() => running.delete(id)));
      return running.get(id);
    },
    // The clip bytes, or null (logged) when it is not made yet.
    clip(model, voice, key) {
      try { return fs.readFileSync(clipPath(home, model, voice, key)); } catch { log("INFO", "announce", `missing ${key}`); return null; }
    },
  };
}
