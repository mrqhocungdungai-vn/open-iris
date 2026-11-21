// Spike A0 (docs/system-announce-plan.md): can a separate Live session speak the 6 fixed announcement lines word for word?
// Per model × line × run: ms from connect to last audio, audio seconds, transcript match, tries (max 3). Costs quota.
// Usage: node scripts/spikes/announce-clips.mjs <out-dir> [runs]. Writes results.jsonl and one <model>/<key>.pcm per line (last run).
// Reads GEMINI_API_KEY from ~/.open-iris/.env and the voice from config.json; never prints the key.
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

const home = join(homedir(), ".open-iris");
const key = readFileSync(join(home, ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
const voice = JSON.parse(readFileSync(join(home, "config.json"), "utf8")).voice || "Zephyr";
const [out, runs = "3"] = process.argv.slice(2);
const LINES = { "vision-on": "Hand Task Vision enabled", "vision-off": "Hand Task Vision disabled", "control-on": "Hand control on", "control-off": "Hand control off", "listen-on": "Listen mode active", "listen-off": "Listen mode inactive" };
const MODELS = ["gemini-3.8-live", "gemini-3.1-flash-live-preview"];
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function say(model, line) {
  return new Promise(async (done) => {
    const t0 = Date.now(), chunks = [];
    let lastAudio = 0, said = "", s;
    const finish = (err) => { try { s?.close(); } catch {} done({ err, ms: lastAudio ? lastAudio - t0 : null, pcm: Buffer.concat(chunks), said }); };
    const timer = setTimeout(() => finish("timeout"), 20000);
    try {
      s = await new GoogleGenAI({ apiKey: key }).live.connect({
        model: `models/${model}`,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          outputAudioTranscription: {},
          systemInstruction: { parts: [{ text: "You read system announcements aloud. Say exactly the words you are given, once, with nothing before or after." }] },
        },
        callbacks: {
          onmessage: (m) => {
            const c = m.serverContent;
            for (const p of c?.modelTurn?.parts || []) if (p.inlineData?.data) { chunks.push(Buffer.from(p.inlineData.data, "base64")); lastAudio = Date.now(); }
            if (c?.outputTranscription?.text) said += c.outputTranscription.text;
            if (c?.turnComplete) { clearTimeout(timer); finish(null); }
          },
          onclose: (e) => { clearTimeout(timer); if (e.code !== 1000) finish(`close ${e.code} ${e.reason}`); },
        },
      });
      s.sendRealtimeInput({ text: `Say exactly: ${line}` });
    } catch (e) { clearTimeout(timer); finish(e?.message || "connect failed"); }
  });
}

mkdirSync(out, { recursive: true });
for (const model of MODELS) {
  mkdirSync(join(out, model), { recursive: true });
  for (let run = 1; run <= +runs; run++) {
    for (const [k, line] of Object.entries(LINES)) {
      let r, tries = 0;
      do { tries++; r = await say(model, line); } while (tries < 3 && (r.err || norm(r.said) !== norm(line)));
      const row = { model, run, key: k, tries, ms: r.ms, audioS: +(r.pcm.length / 48000).toFixed(2), match: norm(r.said) === norm(line), said: r.said.trim(), err: r.err };
      appendFileSync(join(out, "results.jsonl"), JSON.stringify(row) + "\n");
      console.log(JSON.stringify(row));
      if (r.pcm.length) writeFileSync(join(out, model, `${k}.pcm`), r.pcm);
    }
  }
}
process.exit(0);
