// Spike: voice latency baseline (docs/optimize-plan.md §1). Costs quota; not in `pnpm test`.
// V1 = end of speech sent -> first audio chunk back, V3 = connect -> setupComplete. Speech is macOS `say`, streamed in real time
// in the app's 128-sample (8 ms) frames with the app's setup (all desktop tools, keep on). Reads the key from ~/.open-iris/.env, never prints it.
// Run: node scripts/spikes/live-latency.mjs <out.jsonl> [sessions=20] [turns=2] [model...]
// VAD A/B: VAD=default|high|sil=<ms>|high,sil=<ms>. PAUSES=500,1000 adds one turn per pause per session: a sentence with a planted
// mid-sentence silence; cutoff=true when Iris starts talking before the whole sentence was sent.
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { liveSetup } from "../../src/main/live-config.mjs";
import { desktopTools } from "../../src/main/desktop.mjs";
import { rms16, VOICE_RMS } from "../../src/main/perf.mjs";

const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
if (!key) { console.error("no GEMINI_API_KEY"); process.exit(2); }
const [out, nS = "20", nT = "2", ...models] = process.argv.slice(2);
const MODELS = models.length ? models : ["models/gemini-3.8-live", "models/gemini-3.8-live-extended-thinking", "models/gemini-3.1-flash-live-preview"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (o) => appendFileSync(out, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

const PROMPTS = ["What is the capital of France? Answer in one short sentence.", "How many days are there in a week? Answer briefly.",
  "Name one color of the rainbow.", "What is two plus five?", "Say hello in one short sentence."];
const FRAME = 256; // 128 samples of 16-bit mono at 16 kHz, as mic-downsample.js posts them
const dir = mkdtempSync(join(tmpdir(), "iris-lat-"));
const speech = PROMPTS.map((p, i) => {
  const aiff = join(dir, `${i}.aiff`), wav = join(dir, `${i}.wav`);
  execFileSync("say", ["-o", aiff, p]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const b = readFileSync(wav);
  const at = b.indexOf("data") + 8; // skip the RIFF header and any extra chunks
  const pcm = b.subarray(at, at + b.readUInt32LE(at - 4));
  let last = 0;
  for (let o = 0; o + FRAME <= pcm.length; o += FRAME) if (rms16(pcm.subarray(o, o + FRAME)) > VOICE_RMS) last = o + FRAME;
  return pcm.subarray(0, last); // ends at the last voiced frame: the end of what the user said
});
const SILENCE = Buffer.alloc(FRAME);
const half = (text) => { // same pipeline as above, for one half of a paused sentence
  const aiff = join(dir, `h${text.length}${text[0]}.aiff`), wav = aiff.replace(".aiff", ".wav");
  execFileSync("say", ["-o", aiff, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const b = readFileSync(wav), at = b.indexOf("data") + 8, pcm = b.subarray(at, at + b.readUInt32LE(at - 4));
  let first = -1, last = 0;
  for (let o = 0; o + FRAME <= pcm.length; o += FRAME) if (rms16(pcm.subarray(o, o + FRAME)) > VOICE_RMS) { if (first < 0) first = o; last = o + FRAME; }
  return pcm.subarray(Math.max(0, first), last);
};
const PAUSED = [["Could you tell me", "what the capital of France is?"], ["I would like to know", "how many days are in a week."]].map(([a, b]) => [half(a), half(b)]);
const PAUSES = (process.env.PAUSES ?? "").split(",").filter(Boolean).map(Number);
const VAD = process.env.VAD ?? "default";
const aad = {};
for (const part of VAD.split(",")) {
  if (part === "high") aad.endOfSpeechSensitivity = "END_SENSITIVITY_HIGH";
  else if (part.startsWith("sil=")) aad.silenceDurationMs = Number(part.slice(4));
  else if (part !== "default") throw new Error(`bad VAD part ${part}`);
}
// THINK=none|MINIMAL|LOW|MEDIUM|HIGH overrides liveSetup's thinkingConfig (none = send none).
const THINK = process.env.THINK;
const thinkCfg = (cfg) => { if (!THINK) return cfg; const { thinkingConfig, ...rest } = cfg; return THINK === "none" ? rest : { ...rest, thinkingConfig: { thinkingLevel: THINK } }; };
const vadCfg = Object.keys(aad).length ? { realtimeInputConfig: { automaticActivityDetection: aad } } : {};

// The extended-thinking model closes with 1007 "BLOCKING function calls are not supported" (found by this spike): drop behavior there.
async function session(model, sIdx) {
  const tools = desktopTools();
  let s, onMsg = () => {};
  const t0 = performance.now();
  let setupMs = null;
  const ready = new Promise((res, rej) => {
    new GoogleGenAI({ apiKey: key }).live.connect({
      model,
      config: { responseModalities: ["AUDIO"], inputAudioTranscription: {}, outputAudioTranscription: {}, ...thinkCfg(liveSetup("en", tools, "", { keep: true, model })), ...vadCfg },
      callbacks: {
        onmessage: (m) => { if (m.setupComplete) { setupMs = performance.now() - t0; res(); } onMsg(m); },
        onerror: (e) => rej(e),
        onclose: (e) => rej(new Error(`closed ${e.code} ${e.reason}`)),
      },
    }).then((x) => { s = x; rec({ model, s: sIdx, ev: "connectResolved", ms: Math.round(performance.now() - t0) }); }, rej);
  });
  await ready;
  while (!s) await sleep(5);
  rec({ model, s: sIdx, ev: "V3", ms: Math.round(setupMs) });
  // Mic stream: real-time paced, speech when queued, silence otherwise.
  let queue = null, qOff = 0, endSent = null, running = true;
  const tStream = performance.now();
  let sent = 0;
  const pump = (async () => {
    while (running) {
      const due = Math.floor((performance.now() - tStream) / 8);
      while (sent < due) {
        let f = SILENCE;
        if (queue && qOff < queue.length) { f = queue.subarray(qOff, qOff + FRAME); qOff += FRAME; if (qOff >= queue.length) endSent = performance.now(); }
        try { s.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } }); } catch { running = false; }
        sent++;
      }
      await sleep(4);
    }
  })();
  await sleep(500);
  const turns = [...Array(Number(nT)).keys()].map((t) => ({ p: (sIdx * Number(nT) + t) % speech.length }))
    .concat(PAUSES.map((ms, i) => ({ p: `pause${(sIdx + i) % PAUSED.length}`, pause: ms, pcm: Buffer.concat([PAUSED[(sIdx + i) % PAUSED.length][0], Buffer.alloc(Math.round(ms * 32 / FRAME) * FRAME), PAUSED[(sIdx + i) % PAUSED.length][1]]) })));
  for (const [t, turn] of turns.entries()) {
    const p = turn.p;
    let firstAudio = null, firstHeard = null, lastHeard = null, done;
    const turnDone = new Promise((r) => (done = r));
    onMsg = (m) => {
      const c = m.serverContent;
      if (!c) return;
      const now = performance.now();
      if (c.inputTranscription?.text) { firstHeard ??= now; lastHeard = now; }
      if (!firstAudio && c.modelTurn?.parts?.some((x) => x.inlineData?.data)) firstAudio = now;
      if (c.turnComplete && endSent) done(); // a reply cut in mid-sentence is not the end of this turn
    };
    endSent = null; queue = turn.pcm ?? speech[p]; qOff = 0;
    await Promise.race([turnDone, sleep(25000)]);
    rec({ model, vad: THINK ? `think=${THINK}` : VAD, s: sIdx, turn: t, prompt: p, ev: "V1", pause: turn.pause, cutoff: turn.pause ? !!firstAudio && firstAudio < endSent : undefined, ms: firstAudio && endSent ? Math.round(firstAudio - endSent) : null,
      heardAfterEnd: lastHeard && endSent ? Math.round(lastHeard - endSent) : null, timeout: !firstAudio });
    queue = null;
    await sleep(1500);
  }
  running = false;
  await pump;
  try { s.close(); } catch {}
}

for (const model of MODELS) {
  for (let i = 0; i < Number(nS); i++) {
    try { await session(model, i); } catch (e) { rec({ model, s: i, ev: "error", msg: String(e?.message || e) }); }
  }
}
rec({ ev: "done" });
console.log("done");
