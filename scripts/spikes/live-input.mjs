// Spike: which manual inputs Gemini Live accepts (text, image, pdf, txt) and through which call. Costs quota; not in `pnpm test`.
// Run: node scripts/spikes/live-input.mjs [model...]   Reads GEMINI_API_KEY from ~/.open-iris/.env and never prints it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { GoogleGenAI, Modality } from "@google/genai";

const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
if (!key) { console.error("no GEMINI_API_KEY"); process.exit(2); }
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ["models/gemini-3.8-live", "models/gemini-3.1-flash-live-preview"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 64x64 solid red PNG.
function png() {
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, Buffer.from([255, 0, 0]))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(64).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
function pdf() {
  const stream = "BT /F1 24 Tf 72 700 Td (The code word is BANANA42) Tj ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n", offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out);
}
const b64 = (b) => b.toString("base64");
const ask = "Answer in English in a few words.";
const CASES = {
  "realtime text": (s) => s.sendRealtimeInput({ text: `What is 2+3? ${ask}` }),
  "realtime video png + realtime text": (s) => { s.sendRealtimeInput({ video: { data: b64(png()), mimeType: "image/png" } }); s.sendRealtimeInput({ text: `What colour is the image I just sent? ${ask}` }); },
  "client inline png": (s) => s.sendClientContent({ turns: [{ role: "user", parts: [{ inlineData: { data: b64(png()), mimeType: "image/png" } }, { text: `What colour is this image? ${ask}` }] }], turnComplete: true }),
  "client inline pdf": (s) => s.sendClientContent({ turns: [{ role: "user", parts: [{ inlineData: { data: b64(pdf()), mimeType: "application/pdf" } }, { text: `What is the code word in this PDF? ${ask}` }] }], turnComplete: true }),
  "client inline txt": (s) => s.sendClientContent({ turns: [{ role: "user", parts: [{ inlineData: { data: b64(Buffer.from("The secret fruit is MANGO.")), mimeType: "text/plain" } }, { text: `What is the secret fruit in this file? ${ask}` }] }], turnComplete: true }),
  "client text (file pasted as text)": (s) => s.sendClientContent({ turns: [{ role: "user", parts: [{ text: `File notes.txt:\nThe secret fruit is MANGO.\n\nWhat is the secret fruit? ${ask}` }] }], turnComplete: true }),
};

for (const model of MODELS) {
  for (const [name, run] of Object.entries(CASES)) {
    const c = { said: "", done: false, close: null };
    const ai = new GoogleGenAI({ apiKey: key });
    try {
      const s = await ai.live.connect({ model, config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {} }, callbacks: {
        onmessage: (m) => { if (m.serverContent?.outputTranscription?.text) c.said += m.serverContent.outputTranscription.text; if (m.serverContent?.turnComplete) c.done = true; },
        onclose: (e) => (c.close = `${e.code} ${e.reason}`),
      } });
      run(s);
      const end = Date.now() + 25000;
      while (!c.done && !c.close && Date.now() < end) await sleep(100);
      s.close();
    } catch (e) { c.close = "threw: " + (e?.message || e); }
    console.log(JSON.stringify({ model, name, said: c.said.trim(), done: c.done, close: c.done ? null : c.close }));
    await sleep(300);
  }
}
process.exit(0);
