// Spike: does a gemini-3.8-live session die at ~58 min (forum: 1011 "Deadline expired", then resume → 1007)? Costs quota.
// Holds one session up to 70 min streaming silence, resumes with the latest handle on every close, tries fresh on failure.
// Logs one line per event to argv[2]. Reads GEMINI_API_KEY from ~/.open-iris/.env and never prints it.
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
const out = process.argv[2];
const t0 = Date.now(), min = () => ((Date.now() - t0) / 60000).toFixed(2);
const log = (o) => appendFileSync(out, JSON.stringify({ min: min(), ...o }) + "\n");
const silence = Buffer.alloc(3200).toString("base64");
let handle = null, fails = 0;

function connect(h) {
  return new Promise(async (done) => {
    let mic, opened = Date.now();
    const ai = new GoogleGenAI({ apiKey: key });
    try {
      const s = await ai.live.connect({
        model: "models/gemini-3.8-live",
        config: { responseModalities: [Modality.AUDIO], systemInstruction: { parts: [{ text: "Say OK." }] }, sessionResumption: h ? { handle: h } : {}, contextWindowCompression: { slidingWindow: {} } },
        callbacks: {
          onmessage: (m) => {
            const u = m.sessionResumptionUpdate;
            if (u?.resumable && u.newHandle) { handle = u.newHandle; log({ ev: "handle" }); }
            if (m.goAway) log({ ev: "goAway", timeLeft: m.goAway.timeLeft });
          },
          onclose: (e) => { clearInterval(mic); done({ code: e.code, reason: e.reason, connMin: ((Date.now() - opened) / 60000).toFixed(2) }); },
        },
      });
      log({ ev: "open", withHandle: !!h });
      mic = setInterval(() => { try { s.sendRealtimeInput({ audio: { data: silence, mimeType: "audio/pcm;rate=16000" } }); } catch {} }, 100);
      setTimeout(() => { try { s.close(); } catch {} }, Math.max(0, 70 * 60000 - (Date.now() - t0)));
    } catch (e) { done({ code: "throw", reason: e?.message }); }
  });
}

log({ ev: "start" });
while (Date.now() - t0 < 70 * 60000 && fails < 4) {
  const c = await connect(fails >= 2 ? null : handle);
  log({ ev: "close", ...c });
  fails = c.connMin > 0.5 ? 0 : fails + 1;
  if (fails >= 2) handle = null;
}
log({ ev: "end" });
process.exit(0);
