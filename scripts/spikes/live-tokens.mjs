// Spike (docs/optimize-plan.md §3 step 0): baseline tokens for setup (T1), voice and images (T2). Costs quota; not in `pnpm test`.
// Run: node scripts/spikes/live-tokens.mjs <speech.wav 16kHz mono PCM16> [model]
// Reads GEMINI_API_KEY from ~/.open-iris/.env and never prints it. Uses synthetic skills/notes, never the user's own.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { GoogleGenAI, Modality } from "@google/genai";
import { liveSetup } from "../../src/main/live-config.mjs";
import { desktopTools } from "../../src/main/desktop.mjs";
import { personaBrief, skillTools } from "../../src/main/persona.mjs";

const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
if (!key) { console.error("no GEMINI_API_KEY"); process.exit(2); }
const [wavPath, model = "models/gemini-3.8-live"] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (p, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (p()) return true; await sleep(100); } return false; };
const pick = (u) => ({ prompt: u.promptTokenCount, resp: u.responseTokenCount, details: Object.fromEntries((u.promptTokensDetails || []).map((d) => [d.modality, d.tokenCount])) });

async function open(config) {
  const c = { usage: [], done: 0, close: null };
  try {
    c.session = await new GoogleGenAI({ apiKey: key }).live.connect({ model, config: { responseModalities: [Modality.AUDIO], ...config }, callbacks: {
      onmessage: (m) => { if (m.usageMetadata) c.usage.push(pick(m.usageMetadata)); if (m.serverContent?.turnComplete) c.done++; },
      onclose: (e) => (c.close = `${e.code} ${e.reason}`),
    } });
  } catch (e) { c.close = "connect threw: " + (e?.message || e); }
  return c;
}
async function turn(c, send) {
  const d = c.done; send(c.session);
  await until(() => c.done > d || c.close, 60000); await sleep(500);
  return c.usage.at(-1);
}
const say = (text) => (s) => s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });

// Noise PNG of w×h (content does not matter for image tokens, size does).
function png(w, h) {
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 7 + y * 13) & 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const SYS_BARE = { systemInstruction: { parts: [{ text: "Reply with one word: OK." }] } };
const desk = desktopTools();
const skills = [1, 2, 3].map((i) => ({ name: `sample-skill-${i}`, description: "Sample guide for a made-up task, used only to measure tokens.", body: "" }));
const notes = "Sample owner notes for measuring: call me Alex, I prefer short answers.";
const livestream = " You are the co-host of a livestream. Topic: a sample topic. Goal: a sample goal. Keep every line short, speak right away when a SYSTEM_EVENT_HOOK arrives, and never say a turn is scheduled. Recap what was said every few minutes and invite viewers to follow, like or subscribe in one sentence.";
const T1 = {
  bare: SYS_BARE,
  "default (desktop on, no skills/notes/plugins)": liveSetup("vi", desk, "", { model }),
  "no tools": liveSetup("vi", [], "", { model }),
  "all on (3 skills + notes + livestream)": liveSetup("vi", desk.concat(skillTools(skills)), personaBrief(notes, skills) + livestream, { model }),
};
const out = { model, T1: {}, T2: {} };
for (const [name, cfg] of Object.entries(process.env.ONLY_VOICE ? {} : T1)) {
  const c = await open(cfg);
  if (c.close) { out.T1[name] = c.close; continue; }
  out.T1[name] = await turn(c, say("Say OK.")); c.session.close(); await sleep(300);
  console.log("T1", name, JSON.stringify(out.T1[name]));
}

// T2 images: one session per size, prompt delta vs a text-only first turn in the same bare setup.
for (const [w, h] of process.env.ONLY_VOICE ? [] : [[64, 64], [768, 768], [1920, 1080], [4000, 3000]]) {
  const c = await open(SYS_BARE);
  if (c.close) { out.T2[`img ${w}x${h}`] = c.close; continue; }
  const u = await turn(c, (s) => s.sendClientContent({ turns: [{ role: "user", parts: [{ inlineData: { data: png(w, h).toString("base64"), mimeType: "image/png" } }, { text: "Say OK." }] }], turnComplete: true }));
  out.T2[`img ${w}x${h}`] = u; c.session.close(); await sleep(300);
  console.log("T2", w, h, JSON.stringify(u));
}

// T2 voice: stream the wav as the app does (16 kHz PCM16, ~100 ms chunks at real time), then silence so VAD ends the turn.
if (wavPath) {
  const wav = readFileSync(wavPath); const at = wav.indexOf("data"); const pcm = wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
  const c = await open(SYS_BARE);
  if (c.close) out.T2.voice = c.close;
  else {
    const before = await turn(c, say("Say OK."));
    const d = c.done; const step = 3200;
    const all = Buffer.concat([pcm, Buffer.alloc(32000 * 2)]);
    for (let i = 0; i < all.length; i += step) { c.session.sendRealtimeInput({ audio: { data: all.subarray(i, i + step).toString("base64"), mimeType: "audio/pcm;rate=16000" } }); await sleep(100); }
    c.session.sendRealtimeInput({ audioStreamEnd: true });
    await until(() => c.done > d || c.close, 30000); await sleep(800);
    out.T2.voice = { turns: c.done - d, usages: c.usage.length, seconds: +(pcm.length / 32000).toFixed(1), streamedSeconds: +(all.length / 32000).toFixed(1), before, after: c.usage.at(-1), close: c.close };
    c.session.close();
  }
  console.log("T2 voice", JSON.stringify(out.T2.voice));
}
console.log("\nRESULT", JSON.stringify(out, null, 2));
process.exit(0);
