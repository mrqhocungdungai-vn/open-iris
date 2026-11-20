// pnpm plugin:try <plugin folder> [model]: open Gemini Live with the setup the app builds (liveSetup, SessionStart context, plugin tools),
// send each speak text at once as a SYSTEM_EVENT_HOOK turn between 3 spoken questions, print what Gemini heard and said,
// then run the same questions without the plugin. A run with no inputTranscription at all is the model, not the plugin.
// Key: GEMINI_API_KEY from ~/.open-iris/.env, never printed. Needs macOS `say` and `afconvert`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { desktopTools, TOOL_DEFAULTS } from "../../src/main/desktop.mjs";
import { createHooks, fill, loadPlugin, trustHash } from "../../src/main/hooks.mjs";
import { liveSetup } from "../../src/main/live-config.mjs";
import { greeting, personaBrief } from "../../src/main/persona.mjs";

const [dirArg, modelArg] = process.argv.slice(2);
if (!dirArg) { console.error("usage: pnpm plugin:try <plugin folder> [model]"); process.exit(2); }
const key = readFileSync(join(homedir(), ".open-iris", ".env"), "utf8").match(/^GEMINI_API_KEY=["']?([^"'\s]+)/m)?.[1];
if (!key) { console.error("GEMINI_API_KEY is not set in ~/.open-iris/.env"); process.exit(2); }
const models = modelArg ? [modelArg] : ["models/gemini-3.8-live", "models/gemini-3.1-flash-live-preview"];
const plugin = loadPlugin(resolve(dirArg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fields get their hint without the "e.g." part, every group and tool is on, and the folder is trusted as it is now.
const values = Object.fromEntries(plugin.fields.map((f) => [f.key, f.hint.replace(/^(ví dụ|e\.g\.)\s*:?\s*/i, "") || f.label]));
const config = { [plugin.name]: { on: true, fields: values, groups: Object.fromEntries(plugin.groups.map((g) => [g.name, { on: true }])), tools: Object.fromEntries(plugin.tools.map((t) => [t.name, { on: true }])) } };
// shortcut: only static speak texts; a command hook's speak and a late tool's result are not sent, add them when a plugin needs it.
const events = plugin.groups.flatMap((g) => g.hooks.filter((h) => h.type === "speak").map((h) => `SYSTEM_EVENT_HOOK ${g.id}: ${fill(h.text, values)}`)).filter((t) => !t.endsWith(": "));

const audioDir = mkdtempSync(join(tmpdir(), "iris-try-"));
const speech = (text, i) => {
  const a = join(audioDir, `${i}.aiff`), w = join(audioDir, `${i}.wav`);
  execFileSync("say", ["-o", a, text]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", a, w]);
  const b = readFileSync(w), at = b.indexOf("data") + 8;
  return b.subarray(at, at + b.readUInt32LE(at - 4));
};
const questions = ["What is the capital of France?", "How many days are in a week?", "Name one color of the rainbow."].map(speech);

async function run(model, withPlugin) {
  const home = mkdtempSync(join(tmpdir(), "iris-try-home-"));
  const hooks = createHooks({ plugins: withPlugin ? [plugin] : [], getConfig: () => config, trust: { [plugin.name]: trustHash(plugin.dir) }, home, lang: "en", send: () => false });
  const start = await hooks.emit("SessionStart");
  const tools = desktopTools().filter((t) => TOOL_DEFAULTS[t.name]).concat(hooks.tools());

  let s, onMsg = () => {}, heardAny = false, lastMsg = 0, closed = false;
  await new Promise((res, rej) => new GoogleGenAI({ apiKey: key }).live.connect({
    model,
    config: { responseModalities: ["AUDIO"], inputAudioTranscription: {}, outputAudioTranscription: {}, ...liveSetup("en", tools, personaBrief("", [], ""), { keep: true, model, plugin: start.context, events: hooks.speaks() }) },
    callbacks: { onmessage: (m) => { if (m.setupComplete) res(); onMsg(m); }, onerror: rej, onclose: (e) => { closed = true; rej(new Error(`closed ${e.code} ${e.reason}`)); if (e.code !== 1000) console.log(`  closed ${e.code} ${e.reason}`); } },
  }).then((x) => (s = x)).catch(rej));
  while (!s) await sleep(5);
  // Mic stand-in: one 8 ms frame (256 bytes at 16 kHz) every 8 ms, silence unless a question is playing.
  let q = null, off = 0, live = true, sent = 0;
  const t0 = performance.now(), silence = Buffer.alloc(256);
  (async () => {
    while (live && !closed) {
      for (const due = Math.floor((performance.now() - t0) / 8); sent < due; sent++) {
        let f = silence;
        if (q && off < q.length) { f = q.subarray(off, off + 256); off += 256; }
        s.sendRealtimeInput({ audio: { data: f.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      }
      await sleep(4);
    }
  })();
  const rows = [];
  async function step(label, act) {
    let heard = "", said = "", done;
    const p = new Promise((r) => (done = r));
    onMsg = (m) => {
      lastMsg = performance.now();
      const c = m.serverContent;
      if (!c) return;
      if (c.inputTranscription?.text) { heard += c.inputTranscription.text; heardAny = true; }
      if (c.outputTranscription?.text) said += c.outputTranscription.text;
      if (c.turnComplete && said) done();
    };
    act();
    const replied = await Promise.race([p.then(() => true), sleep(20000).then(() => false)]);
    rows.push({ label, replied, said });
    console.log(`  ${label.padEnd(30)} ${replied ? "reply" : "NONE "} heard=${JSON.stringify(heard.trim().slice(0, 60))} said=${JSON.stringify(said.trim().slice(0, 100))}`);
    q = null;
    for (const end = performance.now() + 10000; performance.now() - lastMsg < 2000 && performance.now() < end;) await sleep(100); // a late reply must not count for the next step
  }
  const turn = (text) => s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
  console.log(`${model.replace("models/", "")} ${withPlugin ? `with ${plugin.name}` : "without plugin"}`);
  await step("greet", () => turn(greeting({ on: true })));
  for (let i = 0; i < Math.max(questions.length, withPlugin ? events.length : 0); i++) {
    if (questions[i]) await step(`voice${i + 1}`, () => { q = questions[i]; off = 0; });
    const ev = withPlugin && events[i];
    if (ev) await step(ev.slice(18, ev.indexOf(":", 18)), () => turn(ev));
  }
  live = false;
  hooks.stop();
  s.close();
  const voice = rows.filter((r) => r.label.startsWith("voice")), ev = rows.filter((r) => r.label.includes("/"));
  const marker = ev.filter((r) => /system.?event|hook/i.test(r.said)).length;
  console.log(heardAny
    ? `  => voice ${voice.filter((r) => r.replied).length}/${voice.length}${withPlugin ? `, events ${ev.filter((r) => r.replied).length}/${ev.length}, marker said ${marker}` : ""}`
    : "  => model deaf (retry): no inputTranscription in this run, not the plugin");
}

for (const model of models) for (const withPlugin of [true, false]) {
  try { await run(model, withPlugin); } catch (e) { console.log(`  failed: ${e?.message || e}`); }
}
process.exit(0);
