const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld("iris", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveLive: (patch) => ipcRenderer.invoke("config:live", patch), // Features › Livestream: { cohost, recap, topic }
  saveKey: (key) => ipcRenderer.invoke("key:save", key), // checked against Gemini first; "" or an error text
  saveWelcomed: () => ipcRenderer.invoke("config:welcomed"),
  saveLang: (lang) => ipcRenderer.invoke("config:lang", lang),
  saveMic: (mic) => ipcRenderer.invoke("config:mic", mic), // { id, label } or null = system default
  saveOwner: (text) => ipcRenderer.invoke("owner:set", text), // ~/.open-iris/IRIS.md
  openSkills: () => ipcRenderer.invoke("skills:open"), // "" or an error text
  start: (opts) => ipcRenderer.invoke("live:start", opts),
  stop: () => ipcRenderer.invoke("live:stop"),
  sendAudio: (arrayBuffer) => ipcRenderer.send("live:audio-in", arrayBuffer),
  // Gallery View feature (main.mjs): opens full screen in the overlay. No file = home folder ~/; dropped File objects carry
  // no path in the page, webUtils reads it here.
  openGallery: (file) => ipcRenderer.invoke("gallery:open", file && webUtils.getPathForFile(file)),
  closeGallery: () => ipcRenderer.send("gallery:close"),
  galleryEnabled: (on) => ipcRenderer.send("gallery:enabled", on), // Features switch → HUD 🖼 button
  onGalleryEnabled: on("gallery:enabled"),
  onGallery: on("gallery"),
  galleryItem: (index) => ipcRenderer.invoke("gallery:item", index), // folder: go in, other file: open in its app
  galleryLook: (index) => ipcRenderer.send("gallery:look", index), // image in the viewer (-1 = none), for Iris
  onAudio: on("live:audio"),
  onInterrupt: on("live:interrupt"),
  onStatus: on("live:status"),
  onLog: on("live:log"),
  // HUD buttons (gesture/hud-ui.js); the main window runs the actual Start/Stop.
  toggle: () => ipcRenderer.send("iris:toggle"),
  onToggle: on("iris:toggle"),
  mute: (on) => ipcRenderer.send("iris:mute", on),
  onMute: on("live:mute"),
  listen: (on) => ipcRenderer.send("iris:listen", on), // listen-only: Iris hears but does not speak or act
  onListen: on("live:listen"),
  getState: () => ipcRenderer.invoke("live:state"),
});

// Hand control: Features › Hand Task Vision in the main window (gesture/setup.js, engine.js) and the HUD (gesture/index.html).
contextBridge.exposeInMainWorld("gesture", {
  mouse: (action, x, y) => ipcRenderer.send("mouse", { action, x, y }),
  vision: (on) => ipcRenderer.send("vision", on),
  onVision: on("vision"),
  hand: (state) => ipcRenderer.send("hand", state), // engine → HUD, per frame
  onHand: on("hand"),
  hudGallery: (open) => ipcRenderer.send("hud:gallery", open),
  onHudGallery: on("hud:gallery"),
  onControl: on("control"),
  setControl: (on) => ipcRenderer.send("control:set", on),
  onPerms: on("perms"),
  onHud: on("hud"),
  onSettings: on("settings"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.send("settings:set", patch),
  getPerms: () => ipcRenderer.invoke("perms:get"),
  requestPerms: () => ipcRenderer.invoke("perms:request"),
  hud: (enter) => ipcRenderer.invoke("hud", enter),
  openSettings: (kind) => ipcRenderer.send("open-settings", kind),
  revealHost: () => ipcRenderer.send("perms:reveal"),
  interactive: (on) => ipcRenderer.send("hud:interactive", on), // HUD stops being click-through over its buttons
});
