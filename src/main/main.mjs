// Minimal port of myiris' Gemini Live session (electron/live-session.mjs,
// live-config.mjs, live-messages.mjs). The API key stays in the main process;
// the renderer only captures the mic and plays audio.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanDevice } from "../renderer/devices.js";
import { cleanTools, desktopTools } from "./desktop.mjs";
import { keyFormatOk, liveSetup } from "./live-config.mjs";
import { cleanTopic, cohostBrief, createRecap, LISTEN_OFF_EVENT, LISTEN_ON_EVENT, RECAP_EVENT, refuseCalls } from "./livestream.mjs";
import { cleanSkills, loadOwner, loadSkills, personaBrief, saveOwner, skillTools } from "./persona.mjs";
import { closeHud, initGesture, lockHand, pipeLogs, setGallery } from "../gesture/hud.mjs";

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

const MODELS = ["models/gemini-3.8-live", "models/gemini-3.8-live-extended-thinking", "models/gemini-3.1-flash-live-preview"];
const VOICES = ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus"];
const LANGS = ["vi", "en"];
const configFile = path.join(home, "config.json");
// IPC/file trust boundary: anything not in an allowlist falls back to the default (first entry).
const pick = (list, value) => (list.includes(value) ? value : list[0]);
const clean = (c) => ({ lang: pick(LANGS, c?.lang), model: pick(MODELS, c?.model), voice: pick(VOICES, c?.voice), mic: cleanDevice(c?.mic), tools: cleanTools(c?.tools), skills: cleanSkills(c?.skills), cohost: c?.cohost === true, recap: c?.recap !== false, topic: cleanTopic(c?.topic), welcomed: c?.welcomed === true });
const writeConfig = (c) => fs.writeFileSync(configFile, JSON.stringify(clean(c), null, 2) + "\n");
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
let chunksOut = 0; // audio chunks received this turn
let enabledTools = []; // registry entries switched on for this session
// The window is already destroyed when window-all-closed calls stopLive().
// The HUD (gesture/) shows status and transcript too; audio goes to the main window only.
let liveStatus = "offline"; // last live:status, for a HUD opened mid-session
const send = (channel, payload) => {
  if (channel === "live:status") liveStatus = payload;
  for (const w of channel === "live:audio" ? [win] : BrowserWindow.getAllWindows()) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
};
let muted = false; // HUD 🔇: mic chunks are dropped here, the session stays open
// Livestream (Features tab): listen-only drops Iris's audio and transcript and refuses tools, the mic still goes in.
let listenOnly = false;
let recapOn = false; // co-host and recap switches as they were at connect
const recap = createRecap({
  send: () => {
    if (!recapOn || listenOnly || !session) return false; // retried next second, see createRecap
    session.sendRealtimeInput({ text: RECAP_EVENT });
    log("INFO", "live", "recap sent");
    return true;
  },
});

// A second live:start while one is still connecting is a no-op.
let starting = false;
async function startLive(opts) {
  if (session || starting) return;
  starting = true;
  try {
    await connectLive(opts);
  } finally {
    starting = false;
  }
}

async function connectLive(opts) {
  const { lang, model, voice, tools, skills: skillOn } = clean(opts);
  const saved = readConfig();
  writeConfig({ ...saved, lang, model, voice, tools, skills: { ...saved.skills, ...skillOn } }); // keeps the switches of skills not listed now
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("ERROR", "live", `GEMINI_API_KEY is not set (${envFile})`);
    throw new Error(`GEMINI_API_KEY is not set (${envFile})`);
  }
  // IRIS.md and skills are read here, once: edits apply from the next Start, like the tool switches.
  const skills = loadSkills(home, (m) => log("WARN", "skills", m)).filter((s) => skillOn[s.name] !== false);
  enabledTools = desktopTools().filter((t) => tools[t.name]).concat(skillTools(skills));
  // Livestream co-host, read from config like IRIS.md: switch and topic apply from the next Start. Owner notes stay last.
  recapOn = saved.cohost && saved.recap;
  const brief = (saved.cohost ? cohostBrief(saved.topic, recapOn) : "") + personaBrief(loadOwner(home), skills);
  log("INFO", "live", `connecting model=${model} voice=${voice} lang=${lang} tools=${enabledTools.map((t) => t.name).join(",") || "none"} cohost=${saved.cohost} recap=${recapOn}`);
  chunksIn = 0;
  chunksOut = 0;
  send("live:status", "connecting");
  const ai = new GoogleGenAI({ apiKey });
  let me; // this connection; onclose of an older one must not reset a newer session
  me = session = await ai.live.connect({
    model,
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...liveSetup(lang, enabledTools, brief),
    },
    callbacks: {
      onopen: () => {
        log("INFO", "live", "connected");
        send("live:status", "listening");
        recap.start();
      },
      onmessage: handleMessage,
      onerror: (e) => {
        log("ERROR", "live", `ws error: ${e?.message || e}`);
        send("live:log", `error: ${e?.message || e}`);
      },
      onclose: (e) => {
        // shortcut: no reconnect/session resumption, Gemini closes after ~10 min; port scheduleReconnect from myiris when needed.
        log("INFO", "live", `closed code=${e?.code} reason=${e?.reason || "(none)"} micChunksSent=${chunksIn}`);
        if (session !== me) return;
        session = null;
        recap.stop();
        setListenOnly(false);
        send("live:log", `closed: ${e?.code} ${e?.reason || ""}`);
        send("live:status", "offline");
      },
    },
  });
  if (looking) tellLooking(); // an image was already open before Iris started
}

function handleMessage(message) {
  if (message.goAway) log("WARN", "live", `goAway timeLeft=${message.goAway.timeLeft}`);
  if (message.toolCall?.functionCalls) handleToolCalls(message.toolCall.functionCalls);
  // shortcut: a cancelled call still runs to the end; its response is just not sent. Abort execFile if that matters.
  for (const id of message.toolCallCancellation?.ids || []) {
    cancelledCalls.add(id);
    log("INFO", "tool", `cancelled id=${id}`);
  }
  const content = message.serverContent;
  if (!content) return;
  if (content.inputTranscription?.text) {
    log("DEBUG", "transcript", `you: ${content.inputTranscription.text}`);
    send("live:log", `you: ${content.inputTranscription.text}`);
    recap.markActivity();
  }
  if (listenOnly) {
    // Only the user's words show; Iris's audio and transcript are dropped.
    if (content.turnComplete || content.interrupted) send("live:status", "listening");
    return;
  }
  if (content.outputTranscription?.text) {
    recap.markActivity();
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
    if (chunksOut++ === 0) log("INFO", "turn", `speaking (${d.mimeType})`);
    send("live:audio", { data: d.data, mimeType: d.mimeType || "audio/pcm;rate=24000" });
    send("live:status", "speaking");
  }
  if (content.turnComplete) {
    log("INFO", "turn", `complete, ${chunksOut} audio chunks`);
    chunksOut = 0;
    send("live:status", "listening");
  }
}

const cancelledCalls = new Set();
async function handleToolCalls(calls) {
  const s = session;
  if (listenOnly) {
    log("INFO", "tool", `refused in listen-only: ${calls.map((c) => c.name).join(",")}`);
    try { s?.sendToolResponse({ functionResponses: refuseCalls(calls) }); } catch (e) { log("ERROR", "tool", `sendToolResponse: ${e?.message || e}`); }
    return;
  }
  const functionResponses = await Promise.all(calls.map(async ({ id, name, args }) => {
    const tool = enabledTools.find((t) => t.name === name);
    // Desktop calls queue up in call order (a click then a type must not race); skill calls run in parallel.
    const r = !tool ? { ok: false, error: `tool not enabled: ${name}` } : tool.desktop ? await (desktopQueue = desktopQueue.then(() => runDesktop(tool, args))) : await tool.run(args);
    const out = r.ok ? { output: r.output } : { error: r.error };
    log("INFO", "tool", `${name} ${JSON.stringify(args || {}).slice(0, 80)} -> ${r.ok ? "ok" : "error"} ${JSON.stringify(out).length}B`);
    if (!r.ok && tool?.desktop) log("WARN", "tool", `${name} ${JSON.stringify(r.error).slice(0, 2000)}`); // why a type or click failed, for the eval loop
    return { id, name, response: out };
  }));
  // A cancelled call's response is never sent, nor any response for a session that has ended since.
  const live = functionResponses.filter((f) => !cancelledCalls.delete(f.id));
  if (s !== session || !live.length) return;
  try { s.sendToolResponse({ functionResponses: live }); } catch (e) { log("ERROR", "tool", `sendToolResponse: ${e?.message || e}`); }
}

// The hand must not move the mouse while agent-desktop clicks or types (headed typing takes the keyboard and front app).
let desktopQueue = Promise.resolve();
async function runDesktop(tool, args) {
  lockHand(true);
  send("live:log", `🤖 ${tool.name}`); // the HUD transcript shows why the hand stopped answering
  try { return await tool.run(args); } finally { lockHand(false); }
}

function stopLive() {
  if (session) log("INFO", "live", "stop requested");
  const s = session;
  session = null;
  recap.stop();
  try { s?.close(); } catch { /* ignore close races */ }
  send("live:interrupt");
  send("live:status", "offline");
  setMuted(false);
  setListenOnly(false);
}
function setMuted(on) {
  muted = on;
  send("live:mute", on);
}
// The notice tells Gemini why it gets no turn; the gate above enforces it. Turning on cuts what Iris was saying.
function setListenOnly(on) {
  if (listenOnly === on) return;
  listenOnly = on;
  log("INFO", "live", `listen-only ${on ? "on" : "off"}`);
  if (session) {
    try { session.sendRealtimeInput({ text: on ? LISTEN_ON_EVENT : LISTEN_OFF_EVENT }); } catch (e) { log("ERROR", "live", `listen notice: ${e?.message || e}`); }
    if (on) send("live:interrupt");
  }
  send("live:listen", on);
}

ipcMain.handle("config:get", () => ({ ...readConfig(), hasKey: !!process.env.GEMINI_API_KEY, owner: loadOwner(home), options: { lang: LANGS, model: MODELS, voice: VOICES, desktopTools: desktopTools().map((t) => t.name), skills: loadSkills(home).map(({ name, description }) => ({ name, description })) } }));
ipcMain.handle("owner:set", (_e, text) => saveOwner(home, text));
ipcMain.handle("skills:open", () => {
  const dir = path.join(home, "skills");
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir); // "" or macOS's error text
});
ipcMain.handle("config:lang", (_e, lang) => writeConfig({ ...readConfig(), lang })); // UI + Gemini language; clean() drops unknown values
ipcMain.handle("config:mic", (_e, mic) => {
  writeConfig({ ...readConfig(), mic });
  log("INFO", "devices", `mic ${JSON.stringify(readConfig().mic?.label ?? "default")}`);
});
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
// Features › Livestream: { cohost, recap, topic }, any subset; clean() checks each one.
ipcMain.handle("config:live", (_e, patch) => {
  const { cohost, recap, topic } = patch || {};
  writeConfig({ ...readConfig(), ...(cohost !== undefined && { cohost }), ...(recap !== undefined && { recap }), ...(topic !== undefined && { topic }) });
  log("INFO", "live", `livestream settings ${JSON.stringify({ cohost, recap, topic })}`);
});
ipcMain.handle("live:start", (_e, opts) => startLive(opts));
ipcMain.handle("live:stop", () => stopLive());
// HUD buttons: Start/Stop goes through the main window so it uses that window's model/voice/tool picks.
ipcMain.handle("live:state", () => ({ status: liveStatus, muted, listenOnly }));
ipcMain.on("iris:toggle", () => win && !win.isDestroyed() && win.webContents.send("iris:toggle"));
ipcMain.on("iris:mute", (_e, on) => {
  log("INFO", "live", `mic ${on === true ? "muted" : "unmuted"}`);
  setMuted(on === true);
});
ipcMain.on("iris:listen", (_e, on) => session && setListenOnly(on === true)); // only while Iris runs, like the buttons
ipcMain.on("live:audio-in", (_e, arrayBuffer) => {
  if (!session || muted || !arrayBuffer?.byteLength) return;
  chunksIn++;
  session.sendRealtimeInput({
    audio: { data: Buffer.from(arrayBuffer).toString("base64"), mimeType: "audio/pcm;rate=16000" },
  });
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
  if (/\.(command|sh|tool|terminal|workflow|scpt|applescript|jar|pkg|mpkg)$/i.test(f) || st?.mode & 0o111) return readConfig().lang === "en" ? "runnable file, not opened from the gallery" : "file chạy được, không mở từ gallery";
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
  session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false });
}

process.on("uncaughtException", (e) => log("ERROR", "main", e?.stack || String(e)));
process.on("unhandledRejection", (e) => log("ERROR", "main", e?.stack || String(e)));

app.whenReady().then(() => {
  app.dock?.setIcon(path.join(import.meta.dirname, "../../assets", "icon.png")); // no packaged build yet, so dev would show Electron's icon
  log("INFO", "app", `start electron=${process.versions.electron} level=${process.env.LOG_LEVEL || "info"} log=${logFile}`);
  initGesture(log, home, (on) => {
    // A full turn, so Iris speaks: the user may not be looking at the HUD when the 🤘 hold or ⌃⌥G switches it.
    session?.sendClientContent({ turns: [{ role: "user", parts: [{ text: `[hand control] Hand control is now ${on ? "ON" : "OFF"}. Tell the user in one short sentence.` }] }], turnComplete: true });
  });
  win = new BrowserWindow({
    width: 800,
    height: 960,
    // backgroundThrottling off: Hand Task Vision (gesture/engine.js) runs here and must keep tracking behind other apps.
    webPreferences: { preload: path.join(import.meta.dirname, "../preload/preload.cjs"), backgroundThrottling: false },
  });
  pipeLogs(win.webContents);
  win.on("closed", closeHud); // the HUD is click-through, so it must not outlive the window that controls it
  win.loadFile("src/renderer/index.html");
});

app.on("window-all-closed", () => {
  stopLive();
  app.quit();
});
