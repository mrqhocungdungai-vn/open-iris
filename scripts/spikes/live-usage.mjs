// Spike: what usageMetadata says about context size on each Live model. Costs quota; not part of `pnpm test`.
// Run: node scripts/spikes/live-usage.mjs   Reads GEMINI_API_KEY from ~/.open-iris/.env and never prints it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
if (!key) { console.error("no GEMINI_API_KEY"); process.exit(2); }
const ALL = ["models/gemini-3.8-live", "models/gemini-3.8-live-extended-thinking", "models/gemini-3.1-flash-live-preview"];
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (p, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (p()) return true; await sleep(100); } return false; };
const pick = (u) => u && { prompt: u.promptTokenCount, total: u.totalTokenCount, resp: u.responseTokenCount, tool: u.toolUsePromptTokenCount, thoughts: u.thoughtsTokenCount, details: (u.promptTokensDetails || []).map((d) => `${d.modality}:${d.tokenCount}`).join(" ") };

async function open(model, config) {
  const c = { usage: [], handle: null, msgs: 0, done: 0, close: null };
  const ai = new GoogleGenAI({ apiKey: key });
  try {
    c.session = await ai.live.connect({ model, config: { responseModalities: [Modality.AUDIO], ...config }, callbacks: {
      onmessage: (m) => {
        c.msgs++;
        if (m.usageMetadata) c.usage.push({ at: c.msgs, turnDone: !!m.serverContent?.turnComplete, ...pick(m.usageMetadata) });
        if (m.serverContent?.turnComplete) c.done++;
        if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) c.handle = m.sessionResumptionUpdate.newHandle;
      },
      onclose: (e) => (c.close = `${e.code} ${e.reason}`),
    } });
  } catch (e) { c.close = "connect threw: " + (e?.message || e); }
  return c;
}
async function ask(c, text) {
  const d = c.done;
  c.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
  await until(() => c.done > d || c.close, 45000);
  await sleep(300); // usageMetadata may come after turnComplete
  return c.usage.at(-1)?.prompt;
}
const filler = (n) => Array.from({ length: n }, (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog near the river bank.`).join("\n");

const out = {};
for (const model of MODELS) {
  const r = (out[model] = {});
  const sys = { parts: [{ text: "Reply with one word: OK." }] };
  // Small trigger so a trim shows within a few turns.
  const cfg = { ...(/thinking/.test(model) && { thinkingConfig: { thinkingLevel: "LOW" } }), systemInstruction: sys, sessionResumption: {}, contextWindowCompression: { triggerTokens: "3000", slidingWindow: { targetTokens: "1000" } } };
  const c = await open(model, cfg);
  if (c.close) { r.error = c.close; console.log(model, r.error); continue; }
  r.prompts = [];
  r.debug = () => ({ msgs: c.msgs, close: c.close });
  for (let i = 0; i < 6; i++) r.prompts.push(await ask(c, `Turn ${i}. Just say OK.\n${filler(40)}`)); // ~800 tokens each
  r.samples = c.usage.slice(0, 3);
  r.usageMessages = c.usage.length; r.turns = c.done;
  r.usageOnTurnComplete = c.usage.filter((u) => u.turnDone).length;
  await until(() => c.handle, 5000);
  const handle = c.handle;
  r.beforeResume = c.usage.at(-1)?.prompt;
  c.session.close(); await sleep(500);
  const d = await open(model, { ...cfg, sessionResumption: { handle } });
  if (d.close) r.resume = "failed: " + d.close;
  else { r.afterResume = await ask(d, "Just say OK."); d.session.close(); }
  r.debug = r.debug(); console.log(model, JSON.stringify(r));
}
console.log("\nRESULT", JSON.stringify(out, null, 2));
process.exit(0);
