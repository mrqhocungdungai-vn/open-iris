// Hand-gesture mouse control (ported from the hand-task-vison PoC), imported by ../main/main.mjs. Two separate switches:
// - Hand Task Vision ("vision", Features in the main window): the main window renderer (engine.js) runs MediaPipe
//   HandLandmarker on the camera; this process turns its output into real mouse events via the Swift helper.
// - HUD ("hud"): the corner dock of a transparent, click-through overlay over the primary display. It only shows things
//   (cursor ring, pose, transcript, voice buttons); it works with or without vision, and vision works without it.
// - Gallery (Features in the main window, main.mjs): full screen in the same overlay window, independent of the other two.
// The overlay window lives while the HUD or the gallery is on.
// Ctrl+Option+G toggles control, Ctrl+Option+Q turns vision off, Ctrl+Option+H toggles the HUD, Ctrl+Option+C its camera.
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, shell, systemPreferences, Tray } from "electron";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanDevice } from "../renderer/devices.js";
import { rendererLevel } from "./logs.js";
import { chatPlace } from "./talk.js";

// main.mjs owns the log and the data folder (~/.open-iris); it calls initGesture() once at startup.
let log = () => {};
let SETTINGS = null;

const dir = import.meta.dirname;
const bin = path.join(dir, ".build", "mouse");
const src = path.join(dir, "mouse.swift");

export function initGesture(mainLog, home, changed) {
  log = mainLog;
  onChange = changed;
  SETTINGS = path.join(home, "gesture.json");
  try { setSettings(JSON.parse(fs.readFileSync(SETTINGS, "utf8"))); } catch {} // missing or bad file: defaults
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    log("INFO", "mouse", "compiling mouse.swift");
    try {
      execFileSync("swiftc", ["-O", src, "-o", bin], { stdio: "inherit" });
    } catch (e) {
      // The app still opens (voice works); only hand control has no mouse.
      return log("ERROR", "mouse", `cannot compile mouse.swift (Xcode Command Line Tools installed?): ${e.message}`);
    }
  }
  startHelper();
}

let mouse;
function startHelper() {
  mouse = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
  mouse.stdin.on("error", () => {}); // a dead helper: the exit log below says it once, not one EPIPE per frame
  mouse.stdout.on("data", (d) => log(String(d).includes("untrusted") ? "WARN" : "INFO", "mouse", `helper accessibility: ${String(d).trim()}`));
  mouse.on("exit", (code, sig) => log(sig ? "INFO" : "ERROR", "mouse", `helper exited code=${code} signal=${sig}`));
}
const send = (line) => mouse?.stdin.writable && mouse.stdin.write(`${line}\n`);

// While a desktop tool runs (main.mjs), hand mouse events are dropped so they cannot fight agent-desktop's clicks and keys.
let locked = false;
export function lockHand(on) {
  locked = on;
  if (on) send("up 0 0"); // a held pinch must not stay down under the agent's click
}

// move/down/up/right: x, y are 0..1 across the primary display. scroll: x, y are pixel deltas.
// shortcut: primary display only; use screen.getAllDisplays() union bounds when multi-monitor matters.
ipcMain.on("mouse", (_e, { action, x, y }) => {
  if (locked || !["move", "down", "up", "right", "scroll"].includes(action) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (action === "scroll") return send(`scroll ${Math.round(x)} ${Math.round(y)}`);
  const b = screen.getPrimaryDisplay().bounds;
  const cmd = `${action} ${Math.round(b.x + x * (b.width - 1))} ${Math.round(b.y + y * (b.height - 1))}`;
  if (action !== "move") log("DEBUG", "mouse", cmd); // clicks only; moves arrive 30x/s
  send(cmd);
});

// Hand control settings, in their own file (config.json belongs to the voice side), see initGesture().
// span: hand area → whole screen (see cursorFrom). mode: "absolute" (hand position) | "trackpad" (hand motion).
// camera: show the camera preview on the HUD (false = only the gesture line). side: hand that drives the mouse.
// cam: which camera, { id, label } or null = system default (Settings › Camera, renderer/devices.js).
let settings = { span: 0.4, mode: "trackpad", camera: true, side: "right", cam: null }; // trackpad by default: easier on big screens (user choice)
ipcMain.handle("settings:get", () => settings);
function setSettings({ span = settings.span, mode = settings.mode, camera = settings.camera, side = settings.side, cam = settings.cam } = {}) {
  if (!(span >= 0.2 && span <= 1) || !["absolute", "trackpad"].includes(mode) || typeof camera !== "boolean" || !["right", "left"].includes(side)) return;
  settings = { span, mode, camera, side, cam: cleanDevice(cam) };
  fs.writeFileSync(`${SETTINGS}.tmp`, JSON.stringify(settings));
  fs.renameSync(`${SETTINGS}.tmp`, SETTINGS); // atomic: a crash mid-write must not reset hand settings
  log("INFO", "settings", JSON.stringify(settings));
  broadcast("settings", settings); // HUD (its 📷 follows ⌃⌥C) + main window
}
ipcMain.on("settings:set", (_e, patch) => setSettings(patch));

let win = null;
let dock = false; // HUD switch
let gallery = null; // the open gallery ({ folder, items }) or null
let galleryOn = false; // Features › Gallery View switch: the HUD shows its 🖼 only while on
ipcMain.on("gallery:enabled", (_e, on) => broadcast("gallery:enabled", (galleryOn = on === true)));
let orbOn = true; // Features › Orb switch: the HUD shows its orb only while on
ipcMain.on("orb:enabled", (_e, on) => broadcast("orb:enabled", (orbOn = on === true)));
ipcMain.on("orb", (_e, input) => win?.webContents.send("orb", input)); // { state, inL, outL } from the main window, which owns the audio
let control = false; // armed by 🤘 hold or Ctrl+Option+G after vision starts, so a real mouse isn't fought on switch-on
let vision = false; // Hand Task Vision: the main window switches it on at launch once permissions are granted (gesture/setup.js)

let onChange; // main.mjs: onChange("vision" | "control", on) on a real change, for the system announcement
function setControl(on, quiet = false) {
  if (on !== control && !quiet) onChange?.("control", on); // setVision resets to off on every start: say it only on a real change
  control = on;
  log("INFO", "control", on ? "on" : "off");
  broadcast("control", on); // engine (main window) + HUD status
}
// [perf] H2 (docs/optimize-plan.md §2): CPU % per Electron process while vision runs. GPU % is not in getAppMetrics.
let perfTimer = 0;
function logMetrics() {
  const names = new Map(BrowserWindow.getAllWindows().map((w) => [w.webContents.getOSProcessId(), w === win ? "hud" : w === pop ? "camera" : "main"]));
  const parts = app.getAppMetrics().map((m) => `${names.get(m.pid) ?? m.type}=${m.cpu.percentCPUUsage.toFixed(1)}`);
  log("INFO", "perf", `[perf] cpu% ${parts.join(" ")} hud=${win ? "on" : "off"} camera=${pop ? "open" : "closed"}`);
}
function setVision(on) {
  if (on === vision) return broadcast("vision", on); // still echo, so a switch that moved on its own settles back
  vision = on;
  log("INFO", "vision", on ? "on" : "off");
  onChange?.("vision", on);
  if (!on) send("up 0 0"); // never leave the button held down
  clearInterval(perfTimer);
  perfTimer = on && setInterval(logMetrics, 5000);
  broadcast("vision", on);
  setControl(false, !on); // every start (and stop) begins paused: 🤘 hold or ⌃⌥G activates; on stop "vision off" alone is said
}
ipcMain.on("vision", (_e, on) => setVision(on === true));
// Engine → HUD, every frame while vision runs (null = no ring). HUD gallery open/closed → engine (two-hand zoom).
ipcMain.on("hand", (_e, s) => { win?.webContents.send("hand", s); pop?.webContents.send("hand", s); });
ipcMain.on("hud:gallery", (_e, on) => {
  broadcast("hud:gallery", on === true);
  if (!on && gallery) setGallery(null); // closed with ✕ in the overlay
});
ipcMain.on("control:set", (_e, on) => setControl(on === true)); // 🤘-hold toggle in the HUD

// macOS grants TCC permissions to the app hosting the terminal we were started from
// (Terminal.app, or Orca for Orca terminals), so walk up the process tree to the outermost .app.
function hostApp() {
  let pid = process.pid;
  let found = null;
  while (pid > 1) {
    const [ppid, ...comm] = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
    const bundle = /^(.*?\.app)\/Contents\/MacOS\//.exec(comm.join(" "))?.[1];
    if (bundle) found = bundle;
    pid = Number(ppid);
  }
  return found;
}
const HOST = hostApp();

// Each state: "granted" | "denied" | "not-determined" | "restricted" | "unknown" (Electron's media access values).
let perms = null;
function checkPerms() {
  const next = {
    host: HOST,
    packaged: app.isPackaged, // built app: the grant goes to open-iris itself, not to a terminal
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    camera: systemPreferences.getMediaAccessStatus("camera"),
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
  };
  if (JSON.stringify(next) === JSON.stringify(perms)) return;
  // A helper started before the grant keeps getting its events dropped; a fresh process picks the grant up.
  if (perms && perms.accessibility !== "granted" && next.accessibility === "granted") { mouse?.kill(); if (mouse) startHelper(); }
  perms = next;
  log(next.accessibility === "granted" && next.camera === "granted" ? "INFO" : "WARN", "perm", JSON.stringify(next));
  broadcast("perms", next);
}

const PANES = { accessibility: "Privacy_Accessibility", camera: "Privacy_Camera", microphone: "Privacy_Microphone" };
ipcMain.on("open-settings", (_e, kind) => {
  if (PANES[kind]) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[kind]}`);
});
ipcMain.on("perms:reveal", () => HOST && shell.showItemInFolder(HOST));

// Fire the macOS prompts only when the user asks, then report where things stand.
ipcMain.handle("perms:request", async () => {
  systemPreferences.isTrustedAccessibilityClient(true);
  for (const media of ["camera", "microphone"]) {
    if (!(await systemPreferences.askForMediaAccess(media))) log("WARN", "perm", `${media} access denied`);
  }
  checkPerms();
  return perms;
});

ipcMain.handle("perms:get", () => {
  checkPerms();
  return perms;
});
ipcMain.handle("hud", (_e, on) => setDock(on === true));
ipcMain.on("hud:interactive", (_e, on) => win?.setIgnoreMouseEvents(on !== true, { forward: true }));

// Renderer console.* and crashes into main.log, for both windows.
export function pipeLogs(wc) {
  wc.on("console-message", (e) => log(rendererLevel(e.level, e.message), "renderer", e.message));
  wc.on("render-process-gone", (_e, d) => log("ERROR", "renderer", `gone reason=${d.reason}`));
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function closeHud() {
  win?.close();
}

function setDock(on) {
  dock = on;
  log("INFO", "app", on ? "HUD on" : "HUD off");
  broadcast("hud", on);
  // HUD is a mode: it replaces the main window (engine and voice keep running hidden); ✕ Thoát HUD or ⌃⌥H brings it back.
  for (const w of BrowserWindow.getAllWindows()) if (w !== win && w !== pop && w !== chat) on ? w.hide() : w.show(); // the pop-out stays as the user left it
  syncOverlay();
  on ? chat || openChat() : chat?.close();
  // The main window is hidden in HUD mode, so the menu bar icon is the way back.
  if (on && !tray) {
    tray = new Tray(path.join(dir, "..", "..", "assets", "trayTemplate.png")); // Template: macOS tints it for light and dark menu bars
    tray.setToolTip("Iris HUD");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Exit HUD (⌃⌥H)", click: () => setDock(false) }, { type: "separator" }, { label: "Quit Iris", role: "quit" }]));
  } else if (!on) tray = (tray?.destroy(), null);
}
let tray = null;

// "Iris Camera": the hand camera (video, bones, pose) in a normal macOS window, so OBS Window Capture can pick it and it can be
// minimized. The HUD 📷 opens and closes it; it also closes with the main window.
let pop = null;
function openPop() {
  if (pop) return pop.show(); // show() also brings it back from the Dock
  pop = new BrowserWindow({
    title: "Iris Camera", width: 480, height: 270, useContentSize: true, backgroundColor: "#181715",
    webPreferences: { preload: path.join(dir, "..", "preload", "preload.cjs"), backgroundThrottling: false }, // OBS keeps getting frames behind other apps
  });
  pop.on("page-title-updated", (e) => e.preventDefault()); // keep the name OBS lists
  // shortcut: shows the engine's 640x480 frame cropped to 16:9 (top and bottom cut), upgrade to a 1280x720 stream once bones are mapped to its field of view
  pop.setAspectRatio(16 / 9);
  pipeLogs(pop.webContents);
  pop.webContents.on("did-finish-load", () => {
    pop.webContents.send("control", control);
    pop.webContents.send("vision", vision);
    pop.webContents.send("settings", settings);
  });
  pop.on("closed", () => { pop = null; log("INFO", "app", "camera pop-out closed"); broadcast("popout", false); });
  pop.loadFile(path.join(dir, "index.html"), { query: { pop: "1" } });
  log("INFO", "app", "camera pop-out open");
  broadcast("popout", true); // the HUD drops its own preview stream
}
ipcMain.on("popout", () => (pop ? pop.close() : openPop()));
export function closePop() {
  pop?.close();
}
// 💬 chat window: type, paste or attach images to Iris while in the HUD (the overlay itself never takes the keyboard).
// Made hidden with the HUD, so it already holds the conversation and opens at once; 💬, ✕ or Esc hides it again.
// type "panel" + focusable: it takes the keyboard without bringing Iris forward, so hiding it leaves you in your app.
let chat = null;
const CHAT_W = 440, CHAT_H = 420;
function openChat() {
  chat = new BrowserWindow({
    show: false, width: CHAT_W, height: CHAT_H, type: "panel", frame: false, resizable: false, skipTaskbar: true, backgroundColor: "#181715",
    webPreferences: { preload: path.join(dir, "..", "preload", "preload.cjs") },
  });
  chat.setAlwaysOnTop(true, "screen-saver", 1); // one step above the overlay
  chat.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  pipeLogs(chat.webContents);
  chat.on("hide", () => broadcast("chat", false));
  chat.on("closed", () => { chat = null; broadcast("chat", false); });
  chat.loadFile(path.join(dir, "chat.html"));
}
ipcMain.on("chat", (_e, d) => {
  if (!chat) return;
  if (chat.isVisible()) return chat.hide();
  const { bounds, workArea } = screen.getPrimaryDisplay(); // the overlay covers bounds, so its CSS px + bounds origin = screen px
  if ([d?.x, d?.y, d?.width, d?.height].every(Number.isFinite)) chat.setBounds(chatPlace({ ...d, x: bounds.x + d.x, y: bounds.y + d.y }, workArea, CHAT_W, CHAT_H));
  chat.show();
  chat.focus();
  log("INFO", "app", "chat open");
  broadcast("chat", true);
});

// main.mjs: the footer 🖼 Gallery button, a dropped folder or the HUD 🖼 button. null closes it.
export function setGallery(g) {
  gallery = g;
  broadcast("gallery", g); // main window switch + the overlay
  syncOverlay();
}
function syncOverlay() {
  if (!dock && !gallery) return closeHud();
  if (!win) openHud(); // its did-finish-load sends dock and gallery
}

function openHud() {
  log("INFO", "app", "overlay open");
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const { x, y, width, height } = bounds; // full display, so the ring can follow the mouse over the menu bar and Dock
  win = new BrowserWindow({
    x, y, width, height,
    type: "panel", // lets the overlay sit over other apps' fullscreen spaces
    transparent: true,
    frame: false,
    hasShadow: false,
    focusable: false, // never steal keyboard focus from the app you are controlling
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(dir, "..", "preload", "preload.cjs"),
      backgroundThrottling: false, // keep tracking while another app has focus, which is the whole point
    },
  });
  // Clicks pass through to whatever is underneath; forward keeps mousemove coming so hud-ui.js can switch it off over its buttons.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, "screen-saver");
  // skipTransformProcessType: otherwise Electron turns the whole app into a UI element (no Dock icon) while the HUD lives.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });

  pipeLogs(win.webContents);
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("control", control);
    win.webContents.send("vision", vision);
    win.webContents.send("settings", settings);
    win.webContents.send("hud", dock);
    win.webContents.send("gallery", gallery);
    win.webContents.send("gallery:enabled", galleryOn);
    win.webContents.send("orb:enabled", orbOn);
  });
  win.on("closed", () => {
    win = null;
    log("INFO", "app", "overlay closed");
    if (dock) setDock(false); // closed with the main window
    if (gallery) setGallery(null);
    broadcast("hud:gallery", false);
  });
  // The panels stay inside the work area (off the menu bar and Dock): its insets go in as CSS lengths.
  const inset = { top: workArea.y - y, left: workArea.x - x, right: x + width - workArea.x - workArea.width, bottom: y + height - workArea.y - workArea.height };
  win.loadFile(path.join(dir, "index.html"), { query: Object.fromEntries(Object.entries(inset).map(([k, v]) => [k, `${v}px`])) });
}

app.whenReady().then(() => {
  checkPerms();
  setInterval(checkPerms, 2000); // live: the panels flip to ✓ as soon as you tick the box in System Settings
  // The HUD is click-through and vision drives the mouse, so these keys must work from any app.
  const keys = {
    "Control+Alt+G": () => setControl(!control),
    "Control+Alt+Q": () => setVision(false),
    "Control+Alt+H": () => setDock(!dock),
    "Control+Alt+C": () => setSettings({ camera: !settings.camera }),
  };
  for (const [key, fn] of Object.entries(keys)) {
    if (!globalShortcut.register(key, fn)) log("WARN", "shortcut", `${key} is taken by another app`);
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (mouse?.stdin.writable) mouse.stdin.end("up 0 0\n"); // never leave the button held down
});
