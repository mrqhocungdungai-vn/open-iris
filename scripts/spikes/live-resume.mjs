// S0 spike (docs/session-plan.md): what Gemini Live really does on resume. Costs quota; not part of `pnpm test`.
// Run: node scripts/spikes/live-resume.mjs [--goaway]   (--goaway holds one connection ~11 min to see goAway.timeLeft)
// Reads GEMINI_API_KEY from ~/.open-iris/.env and never prints it. Exits 1 if an expected finding does not reproduce.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GoogleGenAI, Modality } from "@google/genai";

const env = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8");
const key = env.match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
if (!key) { console.error("no GEMINI_API_KEY in ~/.open-iris/.env"); process.exit(2); }
const MODEL = "models/gemini-3.8-live";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One connection: collects messages, the last resumable handle, the transcript and the close event.
async function open(apiKey, config) {
  const c = { msgs: [], handle: null, said: "", toolCalls: [], close: null, goAway: null };
  let resolveClose; c.closed = new Promise((r) => (resolveClose = r));
  const ai = new GoogleGenAI({ apiKey });
  try {
    c.session = await ai.live.connect({
      model: MODEL,
      config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {}, ...config },
      callbacks: {
        onmessage: (m) => {
          c.msgs.push(m);
          const u = m.sessionResumptionUpdate;
          if (u?.resumable && u.newHandle) c.handle = u.newHandle;
          if (m.serverContent?.outputTranscription?.text) c.said += m.serverContent.outputTranscription.text;
          if (m.toolCall) c.toolCalls.push(...m.toolCall.functionCalls);
          if (m.goAway) c.goAway = { timeLeft: m.goAway.timeLeft, at: Date.now() };
        },
        onerror: (e) => { c.error = e?.message || String(e); },
        onclose: (e) => { c.close = { code: e.code, reason: e.reason, at: Date.now() }; resolveClose(); },
      },
    });
  } catch (e) { c.connectError = e?.message || String(e); resolveClose(); }
  return c;
}
const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return false; };
const turnDone = (c, from) => () => c.msgs.slice(from).some((m) => m.serverContent?.turnComplete) || c.close;
async function ask(c, text, ms = 30000) {
  const from = c.msgs.length, saidFrom = c.said.length;
  c.session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
  await until(turnDone(c, from), ms);
  return c.said.slice(saidFrom).trim();
}
const closeOf = (c) => c.connectError ? `connect threw: ${c.connectError}` : c.close ? `close ${c.close.code} "${c.close.reason}"` : "still open";

const out = {}; let failed = false;
const expect = (ok, what) => { console.log(`${ok ? "OK  " : "FAIL"} ${what}`); if (!ok) failed = true; };

// (e) Bad key: what a non-retryable error looks like.
{
  const c = await open("A".repeat(39), {});
  await until(() => c.close, 10000);
  out.badKey = closeOf(c); console.log("bad key →", out.badKey);
}

// (a) Resume with a different system instruction and tool set.
const toolA = { functionDeclarations: [{ name: "get_weather", description: "Weather for a city.", parameters: { type: "OBJECT", properties: { city: { type: "STRING" } }, required: ["city"] } }] };
const toolB = { functionDeclarations: [{ name: "get_stock", description: "Stock price for a ticker.", parameters: { type: "OBJECT", properties: { ticker: { type: "STRING" } }, required: ["ticker"] } }] };
let handle;
{
  const c = await open(key, { systemInstruction: { parts: [{ text: "Answer in English, in one short sentence. Your secret word is BANANA." }] }, tools: [toolA], sessionResumption: {} });
  expect(!c.connectError, `connect A (${closeOf(c)})`);
  console.log("A:", await ask(c, "Remember this number: 4217. Just say OK."));
  await until(() => c.handle, 10000);
  handle = c.handle; expect(!!handle, "got a resumable handle");
  c.session.close(); await c.closed;
}
{
  const c = await open(key, { systemInstruction: { parts: [{ text: "Answer in English, in one short sentence. Your secret word is APPLE." }] }, tools: [toolB], sessionResumption: { handle } });
  await sleep(1500);
  out.changedConfig = c.close || c.connectError ? `rejected: ${closeOf(c)}` : "accepted";
  if (!c.close && !c.connectError) {
    out.memory = await ask(c, "What number did I ask you to remember? Also say your secret word, and list the names of the tools you have.");
    expect(/4217/.test(out.memory), "history survived the resume");
    out.changedConfig += /APPLE/i.test(out.memory) ? " (new instruction applied)" : /BANANA/i.test(out.memory) ? " (old instruction kept)" : " (instruction unclear)";
    await until(() => c.handle, 10000); handle = c.handle || handle;
    c.session.close(); await c.closed;
  }
  console.log("changed config →", out.changedConfig, "| said:", out.memory);
}

// (b) Invalid handle (an expired one takes 2 h; assume the same path).
{
  const c = await open(key, { systemInstruction: { parts: [{ text: "Say hi." }] }, sessionResumption: { handle: "not-a-real-handle-0000" } });
  await until(() => c.close || c.connectError, 8000);
  out.badHandle = closeOf(c); console.log("bad handle →", out.badHandle);
  if (!c.close && !c.connectError) { out.badHandle += " | said: " + await ask(c, "What number did I ask you to remember?"); c.session.close(); await c.closed; }
}

// (c) Tool call in flight: close without answering it, resume, see what the model does.
{
  const sys = { parts: [{ text: "Answer in English, in one short sentence. Always use get_weather for weather questions." }] };
  const c = await open(key, { systemInstruction: sys, tools: [toolA], sessionResumption: {} });
  await ask(c, "Remember the word ZEBRA. Just say OK.");
  await until(() => c.handle, 10000);
  const before = c.handle;
  c.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "What is the weather in Hanoi?" }] }], turnComplete: true });
  const gotCall = await until(() => c.toolCalls.length, 20000);
  const handleAfterCall = c.handle; // did a resumable update arrive while the call was open?
  c.session.close(); await c.closed;
  const r = await open(key, { systemInstruction: sys, tools: [toolA], sessionResumption: { handle: handleAfterCall } });
  await sleep(4000); // does the model re-issue the call on its own?
  const reissued = r.toolCalls.length;
  const said = r.close ? "" : await ask(r, "Did you get the weather? What word did I ask you to remember?");
  out.toolInFlight = { gotCall, handleMovedDuringCall: handleAfterCall !== before, reissuedOnResume: reissued, callsAfterQuestion: r.toolCalls.length, said, close: r.close && closeOf(r) };
  console.log("tool in flight →", JSON.stringify(out.toolInFlight));
  if (!r.close) { r.session.close(); await r.closed; }
}

// (d) goAway.timeLeft: hold one connection until the server warns and closes.
if (process.argv.includes("--goaway")) {
  const c = await open(key, { systemInstruction: { parts: [{ text: "Say OK." }] }, sessionResumption: {}, contextWindowCompression: { slidingWindow: {} } });
  const t0 = Date.now();
  // An idle client is closed after ~2 min (1008 "client inactivity"), so stream silence like an open mic.
  const silence = Buffer.alloc(3200).toString("base64"); // 100 ms of 16 kHz 16-bit PCM
  const mic = setInterval(() => { try { c.session.sendRealtimeInput({ audio: { data: silence, mimeType: "audio/pcm;rate=16000" } }); } catch {} }, 100);
  await until(() => c.close, 16 * 60000);
  clearInterval(mic);
  out.goAway = { goAway: c.goAway && { timeLeft: c.goAway.timeLeft, afterMin: ((c.goAway.at - t0) / 60000).toFixed(1) }, close: closeOf(c), closedAfterMin: c.close && ((c.close.at - t0) / 60000).toFixed(1) };
  console.log("goAway →", JSON.stringify(out.goAway));
  expect(!!c.goAway, "goAway arrived before the close");
  if (!c.close) c.session.close();
}

console.log("\nRESULT", JSON.stringify(out, null, 2));
process.exit(failed ? 1 : 0);
