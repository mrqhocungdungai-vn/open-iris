// Minimal port of myiris' Gemini Live session (electron/live-session.mjs,
// live-config.mjs, live-messages.mjs). The API key stays in the main process;
// the renderer only captures the mic and plays audio.
import { app, BrowserWindow, dialog, ipcMain, session as sessions, shell } from "electron";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanDevice } from "../renderer/devices.js";
import { pushLine } from "../gesture/talk.js";
import { TOOL_DEFAULTS, cleanTools, desktopTools } from "./desktop.mjs";
import { ABILITIES, abilitiesTool, keyFormatOk, liveSetup, refusedModel } from "./live-config.mjs";
import { contextMeter } from "./context-meter.mjs";
import { cleanInput } from "./input.mjs";
import { createResumer, freshSession, resumeNote } from "./resume.mjs";
import { ago, micMeter, rms16, VOICE_RMS } from "./perf.mjs";
import { LISTEN_OFF_EVENT, LISTEN_ON_EVENT, refuseCalls } from "./listen.mjs";
import { cleanName, cleanSkills, greeting, nameFor, loadPersona, loadSkills, personaBrief, savePersona, skillTools } from "./persona.mjs";
import { installFrom, parseGithubUrl, scanPlugins } from "./plugin-install.mjs";
import { cleanPluginConfig, createHooks, createTaint, deliverLate, killCommands, loadPlugins, NAME, trustHash } from "./hooks.mjs";
import { pluginEntry } from "./plugin-list.mjs";
import { guidePage, permitted, RUNNABLE } from "./guard.mjs";
import { closeHud, closePop, initGesture, lockHand, pipeLogs, setGallery } from "../gesture/hud.mjs";

const execFileP = promisify(execFile);

// Everything open-iris saves lives in ~/.open-iris/ (.env, config.json, logs/).
const home = path.join(os.homedir(), ".open-iris");
fs.mkdirSync(path.join(home, "logs"), { recursive: true, mode: 0o700 });
const envFile = path.join(home, ".env");
// One-time migration: copy only GEMINI_API_KEY from the old repo .env. ~/.open-iris/.env wins once it exists.
const repoEnv = path.join(import.meta.dirname, "../../.env");
let migrated = false;
if (!fs.existsSync(envFile) && fs.existsSync(repoEnv)) {
  const keyLine = fs.readFileSync(repoEnv, "utf8").split(/\r?\n/).find((l) => l.startsWith("GEMINI_API_KEY="));
  if (keyLine) {
    fs.writeFileSync(envFile, keyLine + "\n", { mode: 0o600, flag: "wx" });
    migrated = true;
  }
}
// Real env vars win: loadEnvFile does not overwrite variables that are already set.
try { process.loadEnvFile(envFile); } catch { /* no .env: rely on real env */ }

const MODELS = ["models/gemini-3.8-live", "models/gemini-3.1-flash-live-preview"];
const VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus"];
const LANGS = ["vi", "en"];
const configFile = path.join(home, "config.json");
// IPC/file trust boundary: anything not in an allowlist falls back to the default (first entry).
const pick = (list, value) => (list.includes(value) ? value : list[0]);
const clean = (c) => ({ lang: pick(LANGS, c?.lang), model: pick(MODELS, c?.model), voice: pick(VOICES, c?.voice), mic: cleanDevice(c?.mic), tools: cleanTools(c?.tools), skills: cleanSkills(c?.skills), plugins: cleanPluginConfig(c?.plugins), session: { keep: c?.session?.keep !== false, meter: c?.session?.meter !== false }, compose: c?.compose !== false, name: cleanName(c?.name), greet: c?.greet !== false, abilities: c?.abilities !== false, welcomed: c?.welcomed === true });
// tmp + rename: a crash mid-write must not leave half a file, which readConfig would turn into defaults
const writeConfig = (c) => (fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(clean(c), null, 2) + "\n"), fs.renameSync(`${configFile}.tmp`, configFile));
function readConfig() {
  try { return clean(JSON.parse(fs.readFileSync(configFile, "utf8"))); } catch { return clean(); }
}

// One line per event: `<ISO time> [LEVEL] [tag] message`, to stdout and ~/.open-iris/logs/main.log. Renderer console output is piped in too.
// shortcut: no rotation, the file grows forever; switch to electron-log if that starts to matter.
// LOG_LEVEL=debug|info|warn|error (default info; `pnpm dev` sets debug).
const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const minLevel = LEVELS[(process.env.LOG_LEVEL || "info").toUpperCase()] ?? LEVELS.INFO;
const logFile = path.join(home, "logs", "main.log");
function log(level, tag, message) {
  if ((LEVELS[level] ?? LEVELS.INFO) < minLevel) return;
  const line = `${new Date().toISOString()} [${level}] [${tag}] ${message}`;
  (level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log)(line);
  fs.appendFileSync(logFile, line + "\n");
}
// Logged here because log() needs LOG_LEVEL, which loadEnvFile above may set.
if (migrated) log("INFO", "app", `migrated GEMINI_API_KEY from ${repoEnv} to ${envFile}`);

let win = null;
let session = null;
let chunksIn = 0; // mic chunks sent this session
let micLevel = micMeter(); // [perf] mic lines, new each Start
let chunksOut = 0; // audio chunks received this turn
// [perf] lines (docs/optimize-plan.md §1): V1 last voice -> first Iris audio, V2 toolCall -> toolResponse, V3 connect -> setupComplete.
let perfConnect = null, lastVoiceAt = 0, lastHeardAt = 0;
let enabledTools = []; // registry entries switched on for this session
// The window is already destroyed when window-all-closed calls stopLive().
// The HUD (gesture/) shows status and transcript too; audio goes to the main window only.
let liveStatus = "offline"; // last live:status, for a HUD opened mid-session
const history = []; // recent live:log rows, memory only (gone on quit), for the HUD 💬 chat window opened mid-session
const send = (channel, payload) => {
  if (channel === "live:status") liveStatus = payload;
  if (channel === "live:log") pushLine(history, payload);
  for (const w of channel === "live:audio" ? [win] : BrowserWindow.getAllWindows()) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
};
let muted = false; // HUD 🔇: mic chunks are dropped here, the session stays open
let listenOnly = false; // 👂: Iris's audio and transcript are dropped and tools refused, the mic still goes in
let announcing = null; // timer while Iris says "listen mode is on": its output passes the listen-only gate until then
let hooks = null; // plugin hooks (hooks.mjs) of this session
let userSaid = "", irisSaid = ""; // transcript of the current turn, for UserTurn/IrisTurn hooks
let resumer = null; // "Giữ phiên dài" (resume.mjs): reconnects a dropped connection as the same session
let meter = { model: "", keep: true, last: null }; // context meter (context-meter.mjs) of this session; last is resent after a reconnect
let held = []; // plugin context that came while the connection was down, sent after the reconnect
let taint = createTaint(); // spec §12.6: plugin output reached Gemini → desktop actions and plugin tools wait for the user's words
let startTainted = false; // a SessionStart command hook's text sits in the system instruction, so ↺ taints again
let convo = 0; // bumped by ↺: a late result in flight then belongs to the dropped conversation
const inFlight = new Map(); // tool call id → name, to tell the model which calls a dropped connection cut off
// trust.json: { [plugin]: sha256 } approved in the Plugin tab. File trust boundary: only names and strings survive.
const trustFile = path.join(home, "trust.json");
function readTrust() {
  try {
    return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(trustFile, "utf8"))).filter(([k, v]) => NAME.test(k) && typeof v === "string"));
  } catch { return {}; }
}

// A second live:start while one is still connecting is a no-op.
let starting = false;
let startGen = 0; // bumped by stopLive: a Start still in its SessionStart hooks gives up (window closed mid-start)
async function startLive(opts) {
  if (session || starting || resumer?.live) return; // live = still connecting or reconnecting
  starting = true;
  try {
    await connectLive(opts);
  } finally {
    starting = false;
  }
}

async function connectLive(opts) {
  const gen = startGen;
  perfConnect = { t: Date.now(), kind: "start" };
  lastVoiceAt = lastHeardAt = 0; // V1 of the greeting must not count from the last session's voice
  const { lang, model, voice, tools, skills: skillOn } = clean(opts);
  const saved = readConfig(), keep = saved.session.keep;
  const abilities = typeof opts?.tools?.[ABILITIES] === "boolean" ? opts.tools[ABILITIES] : saved.abilities; // its switch sits with the tool switches
  writeConfig({ ...saved, lang, model, voice, tools, skills: { ...saved.skills, ...skillOn }, abilities }); // keeps the switches of skills not listed now
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("ERROR", "live", `GEMINI_API_KEY is not set (${envFile})`);
    throw new Error(`GEMINI_API_KEY is not set (${envFile})`);
  }
  // IRIS.md and skills are read here, once: edits apply from the next Start, like the tool switches.
  const skills = loadSkills(home, (m) => log("WARN", "skills", m)).filter((s) => skillOn[s.name] !== false);
  enabledTools = desktopTools().filter((t) => tools[t.name]).concat(skillTools(skills));
  // Plugins (hooks.mjs) are read here too: plugin folders and trust apply from the next Start; switches and fields at each event.
  const plugins = loadPlugins(home, (m) => log("WARN", "plugins", m));
  hooks?.stop();
  taint = createTaint((m) => log("INFO", "tool", m)); // a new session starts untainted
  hooks = createHooks({
    plugins, getConfig: () => readConfig().plugins, trust: readTrust(), home, lang, core: { PreToolCall: [(p) => taint.check(p)] },
    send: (text) => {
      if (!session || listenOnly) return false; // kept, retried next second (createHooks)
      try { session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true }); } catch (e) { log("ERROR", "plugins", `speak: ${e?.message || e}`); return false; }
      return true;
    },
    addContext,
    markTaint: () => taint.mark(),
    log: (m) => log("INFO", "plugins", m),
  });
  userSaid = irisSaid = "";
  held = [];
  inFlight.clear();
  meter = { model, keep, last: null };
  const start = await hooks.emit("SessionStart");
  if (gen !== startGen) return void endHooks(); // stopped while the hooks ran
  startTainted = !!start.tainted;
  if (startTainted) taint.mark();
  enabledTools = enabledTools.concat(hooks.tools()); // plugin command tools (spec §12): fixed for this session, like the desktop switches
  const off = Object.keys(TOOL_DEFAULTS).filter((n) => !tools[n]).concat(hooks.offTools());
  if (abilities) enabledTools = enabledTools.concat(abilitiesTool(enabledTools, off));
  const brief = personaBrief(loadPersona(home), skills, nameFor(saved.name, lang)) + (start.context ? ` ${start.context}` : "");
  log("INFO", "live", `connecting model=${model} voice=${voice} lang=${lang} tools=${enabledTools.map((t) => t.name).join(",") || "none"} plugins=${plugins.filter((p) => !p.error && saved.plugins[p.name]?.on).map((p) => p.name).join(",") || "none"}`);
  chunksIn = 0;
  chunksOut = 0;
  micLevel = micMeter();
  send("live:status", "connecting");
  const ai = new GoogleGenAI({ apiKey });
  let opened = false; // a reconnect is the same session: hooks keep running, SessionStart does not fire again
  // Every reconnect resends the exact setup of this Start plus the handle: S0 showed a resume silently keeps the old setup anyway.
  const open = async (handle, current) => {
    let me; // this connection; onclose of an older one must not reset a newer session
    me = await ai.live.connect({
      model,
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        ...liveSetup(lang, enabledTools, brief, { keep, handle, model, off }),
      },
      callbacks: {
        onopen: () => {
          if (!current()) return log("INFO", "live", "connected after stop: ignored"); // onopen fires before connect() resolves
          log("INFO", "live", "connected");
          send("live:status", "listening");
          if (!opened) hooks.start();
          opened = true;
        },
        onmessage: handleMessage,
        onerror: (e) => {
          log("ERROR", "live", `ws error: ${e?.message || e}`);
          send("live:log", `error: ${e?.message || e}`);
        },
        onclose: (e) => {
          log("INFO", "live", `closed code=${e?.code} reason=${e?.reason || "(none)"} micChunksSent=${chunksIn}`);
          if (session !== me) return;
          session = null;
          // shortcut: a mic muted > 2 min gets 1008 "client inactivity" and reconnects every 2 min; stream silence while muted if that churn shows in the logs.
          if (keep && resumer?.live) {
            perfConnect = { t: Date.now(), kind: "reconnect" };
            send("live:status", "connecting");
            return resumer.closed(e);
          }
          endSession(e);
        },
      },
    });
    return me;
  };
  resumer?.stop();
  resumer = createResumer({
    connect: open,
    onReconnect: (s, handle) => {
      session = s;
      const note = resumeNote({ handle, lost: [...inFlight.values()], listenOnly, looking });
      inFlight.clear();
      log("INFO", "live", `resumed ${handle ? "with handle" : "fresh"}`);
      send("live:context", meter.last);
      for (const text of [note, ...held.splice(0)]) {
        try { s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false }); } catch (e) { log("ERROR", "live", `resume note: ${e?.message || e}`); }
      }
    },
    onGiveUp: endSession,
    log: (level, m) => log(level, "live", m),
  });
  session = await resumer.start();
  // Once per Start, here and not in onopen: session is set only now, and a reconnect never comes back through this line.
  const hello = greeting({ on: saved.greet, listenOnly, name: nameFor(saved.name, lang) });
  if (hello) try { session.sendClientContent({ turns: [{ role: "user", parts: [{ text: hello }] }], turnComplete: true }); } catch (e) { log("ERROR", "live", `greeting: ${e?.message || e}`); }
  if (looking) tellLooking(); // an image was already open before Iris started
}

// Silent context for the current connection; held while it is down and sent after the reconnect.
function addContext(text) {
  if (!session && resumer?.live) return void held.push(text); // shortcut: unbounded while down, fine for ~30s of retries; cap it if retries get longer
  try { session?.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false }); } catch (e) { log("ERROR", "plugins", `context: ${e?.message || e}`); }
}

function handleMessage(message) {
  resumer?.update(message.sessionResumptionUpdate);
  if (message.usageMetadata) send("live:context", (meter.last = contextMeter(message.usageMetadata, meter.model, meter.keep))); // once per turn (C0)
  if (message.setupComplete && perfConnect) {
    log("INFO", "perf", `V3 ${perfConnect.kind} ms=${Date.now() - perfConnect.t} model=${meter.model}`);
    perfConnect = null;
  }
  if (message.goAway) log("WARN", "live", `goAway timeLeft=${message.goAway.timeLeft}`);
  if (message.toolCall?.functionCalls) handleToolCalls(message.toolCall.functionCalls);
  // shortcut: a cancelled call still runs to the end; its response is just not sent. Abort execFile if that matters.
  for (const id of message.toolCallCancellation?.ids || []) {
    cancelledCalls.add(id);
    hooks?.cancel(id); // a plugin `late` tool: kill its process, no late result
    log("INFO", "tool", `cancelled id=${id}`);
  }
  const content = message.serverContent;
  if (!content) return;
  if (content.inputTranscription?.text || content.outputTranscription?.text) hooks?.markActivity(); // a speak hook waits for quiet
  if (content.inputTranscription?.text) {
    log("DEBUG", "transcript", `you: ${content.inputTranscription.text}`);
    send("live:log", `you: ${content.inputTranscription.text}`);
    userSaid += content.inputTranscription.text;
    taint.clear(); // the user's own words
    lastHeardAt = Date.now();
  }
  if (content.outputTranscription?.text && !(listenOnly && !announcing)) irisSaid += content.outputTranscription.text; // dropped words were never heard
  if (content.turnComplete) endTurn();
  if (announcing && content.turnComplete) endAnnounce();
  else if (listenOnly && !announcing) {
    // Only the user's words show; Iris's audio and transcript are dropped.
    if (content.turnComplete || content.interrupted) send("live:status", "listening");
    return;
  }
  if (content.outputTranscription?.text) {
    log("DEBUG", "transcript", `iris: ${content.outputTranscription.text}`);
    send("live:log", `iris: ${content.outputTranscription.text}`);
  }
  if (content.interrupted) {
    log("INFO", "turn", `interrupted after ${chunksOut} audio chunks`);
    chunksOut = 0;
    send("live:interrupt");
    send("live:status", "listening");
    return;
  }
  for (const part of content.modelTurn?.parts || []) {
    const d = part.inlineData;
    if (!d?.data || !(d.mimeType || "audio/").startsWith("audio/")) continue;
    if (chunksOut++ === 0) {
      log("INFO", "turn", `speaking (${d.mimeType})`);
      const now = Date.now();
      log("INFO", "perf", `V1 voice_ms=${ago(now, lastVoiceAt)} transcript_ms=${ago(now, lastHeardAt)} model=${meter.model}`); // typed turn: from the send; hook turn: since the last voice
    }
    send("live:audio", { data: d.data, mimeType: d.mimeType || "audio/pcm;rate=24000" });
    send("live:status", "speaking");
  }
  if (content.turnComplete) {
    log("INFO", "turn", `complete, ${chunksOut} audio chunks`);
    chunksOut = 0;
    send("live:status", "listening");
  }
}

// UserTurn/IrisTurn hooks at turnComplete. Not awaited: hooks must not hold up the audio.
function endTurn() {
  const h = hooks, you = userSaid.trim(), iris = irisSaid.trim();
  userSaid = irisSaid = "";
  if (you) h?.emit("UserTurn", { text: you }).catch((e) => log("ERROR", "plugins", `UserTurn: ${e.message}`));
  if (iris) h?.emit("IrisTurn", { text: iris }).catch((e) => log("ERROR", "plugins", `IrisTurn: ${e.message}`));
}
// The session is over for good (keep off, give-up): same teardown as the old onclose.
function endSession(e) {
  resumer?.stop();
  endHooks();
  setListenOnly(false);
  if (refusedModel(e)) send("live:log", readConfig().lang === "en" ? "error: This model is not available. Pick another model in Settings." : "error: Mô hình này chưa dùng được. Hãy chọn mô hình khác trong Thiết lập.");
  send("live:log", `closed: ${e?.code ?? ""} ${e?.reason || ""}`);
  send("live:status", "offline");
}
function endHooks() {
  const h = hooks;
  h?.stop();
  h?.emit("SessionEnd").catch((e) => log("ERROR", "plugins", `SessionEnd: ${e.message}`));
}

const cancelledCalls = new Set();
async function handleToolCalls(calls) {
  const s = session, h = hooks;
  if (listenOnly) {
    log("INFO", "tool", `refused in listen-only: ${calls.map((c) => c.name).join(",")}`);
    try { s?.sendToolResponse({ functionResponses: refuseCalls(calls) }); } catch (e) { log("ERROR", "tool", `sendToolResponse: ${e?.message || e}`); }
    return;
  }
  for (const { id, name } of calls) inFlight.set(id, name);
  const t0 = Date.now(), fromPlugin = new Set();
  const functionResponses = await Promise.all(calls.map(async ({ id, name, args }) => {
    const tool = enabledTools.find((t) => t.name === name);
    if (tool?.plugin) fromPlugin.add(id);
    const pre = (await h?.emit("PreToolCall", { tool: { name, args } })) ?? { block: false, context: "" };
    if (pre.tainted) fromPlugin.add(id); // command hook text goes into this response
    if (pre.block) return { id, name, response: { error: pre.reason } }; // emit already logged who blocked it
    // Desktop calls queue up in call order (a click then a type must not race); skill calls run in parallel.
    const r = !tool ? { ok: false, error: `tool not enabled: ${name}` } : tool.desktop ? await (desktopQueue = desktopQueue.then(() => runDesktop(tool, args))) : await tool.run(args, { id, onLate: (result, { from, args: used }) => sendLate(s, h, id, name, used, from, result) });
    const out = r.ok ? { output: r.output } : { error: r.error };
    log("INFO", "perf", `V2 tool=${name} ms=${Date.now() - t0} ok=${r.ok}`); // includes waiting in desktopQueue
    log("INFO", "tool", `${name} ${JSON.stringify(args || {}).slice(0, 80)} -> ${r.ok ? "ok" : "error"} ${JSON.stringify(out).length}B`);
    if (!r.ok && tool?.desktop) log("WARN", "tool", `${name} ${JSON.stringify(r.error).slice(0, 2000)}`); // why a type or click failed, for the eval loop
    const post = (await h?.emit("PostToolCall", { tool: { name, args }, result: out })) ?? { context: "" };
    if (post.tainted) fromPlugin.add(id);
    const context = [pre.context, post.context].filter(Boolean).join(" ");
    return { id, name, response: context ? { ...out, context } : out, ...(r.late && { willContinue: true }) };
  }));
  for (const { id } of calls) inFlight.delete(id);
  // A cancelled call's response is never sent, nor any response for a session that has ended since.
  const live = functionResponses.filter((f) => !cancelledCalls.delete(f.id));
  if (s !== session || !live.length) return;
  log("INFO", "perf", `V2 batch=${calls.length} ms=${Date.now() - t0}`);
  if (live.some((f) => fromPlugin.has(f.id))) taint.mark(); // output or error, blocked or not: conservative
  try { s.sendToolResponse({ functionResponses: live }); } catch (e) { log("ERROR", "tool", `sendToolResponse: ${e?.message || e}`); }
}

// The second result of a plugin `late` tool (spec §12.3). On the asking connection: a toolResponse. After a resume or
// reconnect of the same conversation: a client text turn (spoken when quiet, silent in 👂). New session or ↺: dropped.
function sendLate(s, h, id, name, args, from, result) {
  const c = convo;
  deliverLate({
    id, name, args, from, result, current: () => h === hooks && c === convo, resumed: () => s !== session, listenOnly: () => listenOnly,
    emit: (event, payload) => h.emit(event, payload), log: (m) => log("INFO", "tool", m),
    send: (fr) => { taint.mark(); try { s.sendToolResponse({ functionResponses: [fr] }); } catch (e) { log("ERROR", "tool", `sendToolResponse late: ${e?.message || e}`); } },
    sendText: (text, silent) => { if (silent) { taint.mark(); addContext(text); } else h.later(name, text, () => taint.mark()); },
  }).catch((e) => log("ERROR", "tool", `${name} late: ${e?.message || e}`));
}

// The hand must not move the mouse while agent-desktop clicks or types (headed typing takes the keyboard and front app).
let desktopQueue = Promise.resolve();
async function runDesktop(tool, args) {
  lockHand(true);
  send("live:log", `🤖 ${tool.name}`); // the HUD transcript shows why the hand stopped answering
  try { return await tool.run(args); } finally { lockHand(false); }
}

function stopLive() {
  startGen++;
  if (session) log("INFO", "live", "stop requested");
  const s = session;
  session = null;
  if (s || resumer?.live) endHooks(); // live: stopped while (re)connecting, hooks still run
  resumer?.stop();
  try { s?.close(); } catch { /* ignore close races */ }
  send("live:interrupt");
  send("live:status", "offline");
  setMuted(false);
  setListenOnly(false);
}
// "↺ Làm mới": a new session with no handle and the same setup; mic and 👂 stay as they are, hooks keep running.
// shortcut: SessionEnd/SessionStart do not fire, so a plugin sees one session; fire them here if a plugin needs the cut.
let clearing = false;
async function clearContext() {
  history.length = 0; // ↺ starts a fresh conversation, so the chat window starts empty too
  if (!session || clearing) return;
  clearing = true;
  log("INFO", "live", "clear requested");
  perfConnect = { t: Date.now(), kind: "clear" };
  const old = session;
  hooks?.killLate(); // their results belong to the conversation ↺ just dropped
  convo++;
  taint.clear();
  if (startTainted) taint.mark();
  session = null; // old's onclose then sees it is not the current connection and does nothing
  inFlight.clear();
  held = [];
  userSaid = irisSaid = "";
  send("live:interrupt");
  send("live:context", (meter.last = null));
  send("live:status", "connecting");
  try {
    session = await freshSession(resumer, old); // null when Stop came during the connect: start() closed it
  } catch (e) {
    log("ERROR", "live", `clear: ${e?.message || e}`);
    endSession({ reason: e?.message || String(e) });
  } finally {
    clearing = false;
  }
  if (!session) return;
  // The new session does not know: say it silently, as after a reconnect.
  if (listenOnly) try { session.sendClientContent({ turns: [{ role: "user", parts: [{ text: "[session] Listen mode is ON: keep listening, do not reply, do not speak and do not call any tool until it ends." }] }], turnComplete: false }); } catch (e) { log("ERROR", "live", `clear: listen note: ${e?.message || e}`); }
  if (looking) tellLooking();
}
function setMuted(on) {
  muted = on;
  send("live:mute", on);
}
// The notice is a full turn, so Iris says the new state aloud from any switch (👂 button, HUD, 👍 hold); the gate above
// enforces the silence after that. Turning on cuts what Iris was saying, then lets the one announcing turn through.
// shortcut: the grace ends at the next turnComplete or after 8s, so a reply already in flight can slip out before the
// announcement; track the announcing turn itself if users hear that.
function setListenOnly(on) {
  if (listenOnly === on) return;
  listenOnly = on;
  log("INFO", "live", `listen-only ${on ? "on" : "off"}`);
  endAnnounce();
  if (session) {
    if (on) {
      send("live:interrupt");
      announcing = setTimeout(endAnnounce, 8000);
    }
    try { session.sendClientContent({ turns: [{ role: "user", parts: [{ text: on ? LISTEN_ON_EVENT : LISTEN_OFF_EVENT }] }], turnComplete: true }); } catch (e) { log("ERROR", "live", `listen notice: ${e?.message || e}`); }
    hooks?.emit("ListenOnlyChanged", { listen_only: on }).catch((e) => log("ERROR", "plugins", `ListenOnlyChanged: ${e.message}`));
  }
  send("live:listen", on);
}
function endAnnounce() {
  clearTimeout(announcing);
  announcing = null;
}

ipcMain.handle("config:get", () => ({ ...readConfig(), hasKey: !!process.env.GEMINI_API_KEY, persona: loadPersona(home), options: { lang: LANGS, model: MODELS, voice: VOICES, desktopTools: desktopTools().map((t) => t.name), skills: loadSkills(home).map(({ name, description }) => ({ name, description })), plugins: loadPlugins(home) } }));
ipcMain.handle("persona:set", (_e, text) => savePersona(home, text));
ipcMain.handle("skills:open", () => {
  const dir = path.join(home, "skills");
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir); // "" or macOS's error text
});
ipcMain.handle("plugins:open", () => {
  const dir = path.join(home, "plugins");
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir); // "" or macOS's error text
});
// Tab Plugin › add: a folder on this Mac or a GitHub link is scanned first, then the user ticks which plugins to copy into
// ~/.open-iris/plugins/ (all off). One pending source at a time; a clone sits in a temp folder until install or the next scan.
let adding = null; // { dir, tmp? }
const dropAdding = () => {
  if (adding?.tmp) fs.rmSync(adding.tmp, { recursive: true, force: true });
  adding = null;
};
app.on("will-quit", dropAdding);
app.on("will-quit", () => { hooks?.killLate(); killCommands(); }); // no plugin process outlives the app
const scanned = (source) => ({ source, plugins: scanPlugins(adding.dir, path.join(home, "plugins")) });
ipcMain.handle("plugins:scan-folder", async (e) => {
  const pick = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ["openDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
  dropAdding();
  adding = { dir: pick.filePaths[0] };
  return scanned(adding.dir);
});
ipcMain.handle("plugins:scan-url", async (_e, url) => {
  const gh = parseGithubUrl(url);
  if (!gh) throw new Error("not a https://github.com/<owner>/<repo> link");
  dropAdding();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "open-iris-clone-"));
  const clone = path.join(tmp, "repo");
  try {
    await execFileP("git", ["clone", "--depth", "1", ...(gh.branch ? ["--branch", gh.branch] : []), "--", gh.repo, clone], { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const dir = fs.realpathSync(path.join(clone, gh.sub)); // throws if the folder is not in the repo
    if (dir !== fs.realpathSync(clone) && !dir.startsWith(fs.realpathSync(clone) + path.sep)) throw new Error(`${gh.sub} points outside the repo`);
    adding = { dir, tmp };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const why = err.code === "ENOENT" && err.path === "git" ? "git is not installed" : err.code === "ENOENT" ? `${gh.sub} is not in that repo` : String(err.stderr || err.message).trim().split("\n").pop();
    log("WARN", "plugins", `clone ${gh.repo} ${gh.branch} ${gh.sub}: ${why}`);
    throw new Error(why);
  }
  log("INFO", "plugins", `cloned ${gh.repo} ${gh.branch} ${gh.sub}`);
  return scanned(url.trim());
});
// picks: scanPlugins paths the user ticked; [] cancels. The pending source is dropped either way.
ipcMain.handle("plugins:install", (_e, picks) => {
  if (!adding) throw new Error("scan a folder or a link first");
  try {
    const result = installFrom(adding.dir, path.join(home, "plugins"), Array.isArray(picks) ? picks.filter((p) => typeof p === "string") : []);
    log("INFO", "plugins", `add ${adding.dir} → installed [${result.installed}] errors ${JSON.stringify(result.errors)}`);
    return result;
  } finally {
    dropAdding();
  }
});
// Tab Plugin: one card per plugin folder, with its saved values and trust state (plugin-list.mjs).
const listPlugins = () => {
  const { plugins: config, lang } = readConfig();
  const trust = readTrust();
  return loadPlugins(home, (m) => log("WARN", "plugins", m)).map((p) => pluginEntry(p, config[p.name], trust[p.name], trustHash, lang));
};
ipcMain.handle("plugins:list", () => listPlugins());
// The renderer sends only the name: main hashes the folder itself. Applies from the next Start.
ipcMain.handle("plugins:trust", (_e, name) => {
  const p = loadPlugins(home).find((x) => x.name === name && !x.error);
  if (!p) throw new Error(`no loadable plugin named ${name}`);
  fs.writeFileSync(trustFile, JSON.stringify({ ...readTrust(), [p.name]: trustHash(p.dir) }, null, 2) + "\n");
  log("INFO", "plugins", `trusted ${p.name}`);
  return listPlugins().find((x) => x.name === p.name);
});
// Tab Plugin › Remove: asks with a native box, then deletes the folder, its trust and its saved settings.
// A running session keeps the plugin it loaded until the next Start.
ipcMain.handle("plugins:remove", async (e, name) => {
  const root = path.join(home, "plugins");
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => !n.startsWith(".")); } catch {}
  if (typeof name !== "string" || !names.includes(name)) throw new Error(`no plugin named ${name}`); // only a folder that is there: no paths
  const en = readConfig().lang === "en";
  const { response } = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: "warning", buttons: en ? ["Remove", "Cancel"] : ["Gỡ", "Huỷ"], defaultId: 1, cancelId: 1,
    message: en ? `Remove the plugin ${name}?` : `Gỡ plugin ${name}?`,
    detail: en ? `Deletes ~/.open-iris/plugins/${name} with its settings and trust.` : `Xoá ~/.open-iris/plugins/${name} cùng cài đặt và tin cậy của nó.`,
  });
  if (response !== 0) return false;
  fs.rmSync(path.join(root, name), { recursive: true, force: true });
  const { [name]: _t, ...trust } = readTrust();
  fs.writeFileSync(trustFile, JSON.stringify(trust, null, 2) + "\n");
  const saved = readConfig();
  const { [name]: _c, ...plugins } = saved.plugins;
  writeConfig({ ...saved, plugins });
  hooks?.prune(); // its config is gone, so its late tool is killed
  log("INFO", "plugins", `removed ${name}`);
  return true;
});
// Tab Plugin: { name, on?, fields?, groups?: { [group]: { on?, every_min? } }, tools?: { [tool]: { on? } } } for one plugin, merged over what is saved; clean() checks every value.
ipcMain.handle("config:plugin", (_e, patch) => {
  const saved = readConfig();
  const name = typeof patch?.name === "string" ? patch.name : "";
  const cur = saved.plugins[name] || {};
  const groups = { ...cur.groups };
  for (const [g, v] of Object.entries(patch?.groups && typeof patch.groups === "object" ? patch.groups : {})) groups[g] = { ...groups[g], ...v };
  const tools = { ...cur.tools };
  for (const [t, v] of Object.entries(patch?.tools && typeof patch.tools === "object" ? patch.tools : {})) tools[t] = { ...tools[t], ...v };
  const next = { ...cur, ...(patch?.on !== undefined && { on: patch.on }), fields: { ...cur.fields, ...patch?.fields }, groups, tools };
  writeConfig({ ...saved, plugins: { ...saved.plugins, [name]: next } });
  hooks?.prune(); // a plugin or tool switched off: its late process stops now
  log("INFO", "plugins", `settings ${name} ${JSON.stringify({ on: patch?.on, fields: Object.keys(patch?.fields || {}), groups: patch?.groups, tools: patch?.tools })}`);
});
ipcMain.handle("config:lang", (_e, lang) => writeConfig({ ...readConfig(), lang })); // UI + Gemini language; clean() drops unknown values
ipcMain.handle("config:mic", (_e, mic) => {
  writeConfig({ ...readConfig(), mic });
  log("INFO", "devices", `mic ${JSON.stringify(readConfig().mic?.label ?? "default")}`);
});
ipcMain.handle("config:keep", (_e, on) => writeConfig({ ...readConfig(), session: { ...readConfig().session, keep: on !== false } })); // clean() keeps only a boolean
ipcMain.handle("config:compose", (_e, on) => writeConfig({ ...readConfig(), compose: on !== false }));
ipcMain.handle("config:meter", (_e, on) => writeConfig({ ...readConfig(), session: { ...readConfig().session, meter: on !== false } }));
ipcMain.handle("config:name", (_e, name) => writeConfig({ ...readConfig(), name })); // clean() keeps one short plain line
ipcMain.handle("config:greet", (_e, on) => writeConfig({ ...readConfig(), greet: on !== false }));
ipcMain.handle("config:welcomed", () => writeConfig({ ...readConfig(), welcomed: true }));
// Welcome wizard: check the key against Gemini, then keep it in ~/.open-iris/.env (0600). Returns "" or an error text.
ipcMain.handle("key:save", async (_e, key) => {
  key = typeof key === "string" ? key.trim() : "";
  if (!keyFormatOk(key)) return "bad format";
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return `HTTP ${r.status}`;
  } catch (e) { return e.message; }
  let lines = [];
  try { lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("GEMINI_API_KEY=")); } catch { /* no .env yet */ }
  fs.writeFileSync(envFile, [...lines, `GEMINI_API_KEY=${key}`].join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  process.env.GEMINI_API_KEY = key;
  log("INFO", "app", `GEMINI_API_KEY saved to ${envFile}`);
  return "";
});
ipcMain.handle("live:start", (_e, opts) => startLive(opts));
ipcMain.handle("live:stop", () => stopLive());
ipcMain.on("live:clear", () => clearContext());
// Manual input box (compose-ui.js): typed text, images and text files as one user turn. label is for the log only.
ipcMain.handle("live:input", (_e, parts, label) => {
  const clean = cleanInput(parts);
  if (!session || !clean) return false;
  log("INFO", "input", `typed turn: ${clean.map((p) => p.inlineData?.mimeType || "text").join(", ")}`);
  taint.clear(); // the user's own typed words
  try { session.sendClientContent({ turns: [{ role: "user", parts: clean }], turnComplete: true }); } catch (e) { log("ERROR", "input", e?.message || String(e)); return false; }
  lastVoiceAt = lastHeardAt = Date.now(); // V1 for a typed turn starts at the send
  send("live:log", `⌨ ${String(label || "").slice(0, 300)}`);
  return true;
});
// HUD buttons: Start/Stop goes through the main window so it uses that window's model/voice/tool picks.
ipcMain.handle("live:state", () => ({ status: liveStatus, muted, listenOnly }));
ipcMain.handle("live:history", () => history);
ipcMain.on("iris:toggle", () => win && !win.isDestroyed() && win.webContents.send("iris:toggle"));
ipcMain.on("iris:mute", (_e, on) => {
  log("INFO", "live", `mic ${on === true ? "muted" : "unmuted"}`);
  setMuted(on === true);
});
ipcMain.on("iris:listen", (_e, on) => session && setListenOnly(on === true)); // only while Iris runs, like the buttons
ipcMain.on("live:audio-in", (_e, arrayBuffer) => {
  if (!session || muted || !arrayBuffer?.byteLength) return;
  chunksIn++;
  const buf = Buffer.from(arrayBuffer);
  const rms = rms16(buf), now = Date.now();
  if (rms > VOICE_RMS) lastVoiceAt = now;
  const lvl = micLevel(rms, now);
  if (lvl) log("INFO", "perf", lvl.line);
  if (lvl?.warn) log("WARN", "live", "mic: no voice-level sound in 30 s; check the mic, its gain, or Settings › Micro");
  try {
    session.sendRealtimeInput({
      audio: { data: buf.toString("base64"), mimeType: "audio/pcm;rate=16000" },
    });
  } catch (e) { log("ERROR", "live", `audio-in: ${e?.message || e}`); }
});

// Gallery View feature: a folder browser full screen in the overlay (gesture/hud-ui.js). Every entry is a card: images show
// the picture, folders open inside, other files open in their macOS app. Only the viewed image's path goes to Gemini, never pixels.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const GALLERY_MAX = 36; // shortcut: only the first 36 entries (folders first, by name) fit the ring; add paging if folders get bigger
let galleryEntries = []; // absolute paths, same order as the cards; the renderer only ever sends an index back
let looking = ""; // image open in the viewer, so Iris knows what "this" is

function showFolder(dir, open = "") {
  const all = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith("."));
  const kind = (d) => (d.isDirectory() ? "dir" : IMAGE_EXT.test(d.name) ? "image" : "file");
  all.sort((a, b) => (kind(b) === "dir") - (kind(a) === "dir") || a.name.localeCompare(b.name, undefined, { numeric: true })); // folders first, A→Z
  const shown = all.slice(0, GALLERY_MAX);
  const up = dir === os.homedir() ? dir : path.dirname(dir); // ~/ is the top: no ⬆ above home
  galleryEntries = [...shown.map((d) => path.join(dir, d.name)), ...(up !== dir ? [up] : [])];
  const items = shown.map((d) => {
    const f = path.join(dir, d.name);
    return { name: d.name, kind: kind(d), ...(kind(d) === "image" && { url: pathToFileURL(f).href }) };
  });
  if (up !== dir) items.push({ name: path.basename(up) || up, kind: "up" }); // last card = left neighbour of the first one on the ring
  log("INFO", "gallery", `opened ${dir} entries=${all.length} shown=${shown.length}`);
  setGallery({ folder: dir, items, more: all.length - shown.length, open: galleryEntries.indexOf(open) });
}

// target: a folder or image dragged from Finder onto the main window; none (🖼 Gallery) = the user's home folder ~/.
// Returns why it did not open, or "".
ipcMain.handle("gallery:open", async (_e, target = os.homedir()) => {
  // IPC trust boundary: any string can arrive, so only an existing folder or image is read.
  const st = typeof target === "string" && path.isAbsolute(target) && fs.statSync(target, { throwIfNoEntry: false });
  if (st?.isDirectory()) showFolder(target);
  else if (st?.isFile() && IMAGE_EXT.test(target)) showFolder(path.dirname(target), target); // a single image opens in the viewer
  else return "not a folder or image";
  return "";
});
ipcMain.on("gallery:close", () => (setGallery(null), lookAt("")));
// Open card i: folder or ⬆ = go there, other file = its default macOS app. Images are viewed by the overlay itself (gallery:look).
ipcMain.handle("gallery:item", async (_e, i) => {
  const f = Number.isInteger(i) ? galleryEntries[i] : undefined; // IPC trust boundary: only an index into the list main built
  if (!f) return "bad index";
  const st = fs.statSync(f, { throwIfNoEntry: false });
  if (st?.isDirectory()) return showFolder(f), "";
  // A stray double pinch must never run a program: scripts and executables are not opened.
  if (RUNNABLE.test(f) || st?.mode & 0o111) return readConfig().lang === "en" ? "runnable file, not opened from the gallery" : "file chạy được, không mở từ gallery";
  log("INFO", "gallery", `open with app ${f}`);
  return shell.openPath(f); // "" or macOS's error text
});
ipcMain.on("gallery:look", (_e, i) => lookAt((Number.isInteger(i) && IMAGE_EXT.test(galleryEntries[i] ?? "") && galleryEntries[i]) || ""));

// Silent context: appended to the conversation without a turn, so Iris answers only when the user speaks.
function lookAt(file) {
  if (file === looking) return;
  looking = file;
  tellLooking();
}
function tellLooking() {
  if (!session) return; // connectLive sends it on connect
  log("INFO", "gallery", `looking at ${looking || "(nothing)"}`);
  const text = looking ? `[gallery] The user is now looking at the image ${looking}` : "[gallery] The user closed the image.";
  try { session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false }); } catch (e) { log("ERROR", "gallery", e?.message || String(e)); }
}

process.on("uncaughtException", (e) => log("ERROR", "main", e?.stack || String(e)));
process.on("unhandledRejection", (e) => log("ERROR", "main", e?.stack || String(e)));

// Every window has the full window.iris bridge: refuse any page but the app's own (a dropped .html, a link). See guard.mjs.
app.on("web-contents-created", (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => (guidePage(url, app.getAppPath()) ? { action: "allow" } : (log("WARN", "security", `window.open refused: ${url}`), { action: "deny" })));
  wc.on("will-navigate", (e, url) => {
    if (guidePage(url, app.getAppPath())) return;
    e.preventDefault();
    log("WARN", "security", `navigation refused: ${url}`);
  });
});

app.whenReady().then(() => {
  sessions.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
    const ok = permitted(permission, details.requestingUrl || wc.getURL(), app.getAppPath());
    if (!ok) log("WARN", "security", `permission refused: ${permission} for ${details.requestingUrl || wc.getURL()}`);
    done(ok);
  });
  app.dock?.setIcon(path.join(import.meta.dirname, "../../assets", "icon.png")); // no packaged build yet, so dev would show Electron's icon
  log("INFO", "app", `start electron=${process.versions.electron} level=${process.env.LOG_LEVEL || "info"} log=${logFile}`);
  initGesture(log, home, (on) => {
    // A full turn, so Iris speaks: the user may not be looking at the HUD when the 🤘 hold or ⌃⌥G switches it.
    try { session?.sendClientContent({ turns: [{ role: "user", parts: [{ text: `[hand control] Hand control is now ${on ? "ON" : "OFF"}. Tell the user in one short sentence.` }] }], turnComplete: true }); } catch (e) { log("ERROR", "control", e?.message || String(e)); }
  });
  win = new BrowserWindow({
    width: 800,
    height: 960,
    // backgroundThrottling off: Hand Task Vision (gesture/engine.js) runs here and must keep tracking behind other apps.
    webPreferences: { preload: path.join(import.meta.dirname, "../preload/preload.cjs"), backgroundThrottling: false },
  });
  pipeLogs(win.webContents);
  win.on("closed", () => (closeHud(), closePop())); // the HUD is click-through and the pop-out has no engine, so neither outlives this window
  win.loadFile("src/renderer/index.html");
});

app.on("window-all-closed", () => {
  stopLive();
  app.quit();
});
