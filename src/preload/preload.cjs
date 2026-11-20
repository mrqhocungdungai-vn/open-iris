const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld("iris", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveKey: (key) => ipcRenderer.invoke("key:save", key), // checked against Gemini first; "" or an error text
  saveWelcomed: () => ipcRenderer.invoke("config:welcomed"),
  saveLang: (lang) => ipcRenderer.invoke("config:lang", lang),
  saveKeep: (on) => ipcRenderer.invoke("config:keep", on), // Features › Giữ phiên dài → config.session.keep
  saveMeter: (on) => ipcRenderer.invoke("config:meter", on), // Features › Hiện mức context → config.session.meter
  saveCompose: (on) => ipcRenderer.invoke("config:compose", on), // Features › Gõ chữ, gửi ảnh và tệp → config.compose
  saveMic: (mic) => ipcRenderer.invoke("config:mic", mic), // { id, label } or null = system default
  saveOwner: (text) => ipcRenderer.invoke("owner:set", text), // ~/.open-iris/IRIS.md
  openSkills: () => ipcRenderer.invoke("skills:open"), // "" or an error text
  openPlugins: () => ipcRenderer.invoke("plugins:open"), // ~/.open-iris/plugins; "" or an error text
  scanPluginFolder: () => ipcRenderer.invoke("plugins:scan-folder"), // folder picker → { source, plugins } or { canceled }
  scanPluginUrl: (url) => ipcRenderer.invoke("plugins:scan-url", url), // git clone --depth 1 of a GitHub link → { source, plugins }
  installPlugins: (picks) => ipcRenderer.invoke("plugins:install", picks), // ticked scan paths ([] cancels) → { installed, errors }
  savePlugin: (patch) => ipcRenderer.invoke("config:plugin", patch), // { name, on?, fields?, groups?: { [group]: { on?, every_min? } } }
  listPlugins: () => ipcRenderer.invoke("plugins:list"), // Plugin tab cards; main rebuilds it on every call
  removePlugin: (name) => ipcRenderer.invoke("plugins:remove", name), // main asks first → true if removed
  trustPlugin: (name) => ipcRenderer.invoke("plugins:trust", name), // main hashes the folder into ~/.open-iris/trust.json
  start: (opts) => ipcRenderer.invoke("live:start", opts),
  stop: () => ipcRenderer.invoke("live:stop"),
  sendAudio: (arrayBuffer) => ipcRenderer.send("live:audio-in", arrayBuffer),
  // Gallery View feature (main.mjs): opens full screen in the overlay. No file = home folder ~/; dropped File objects carry
  // no path in the page, webUtils reads it here.
  openGallery: (file) => ipcRenderer.invoke("gallery:open", file && webUtils.getPathForFile(file)),
  closeGallery: () => ipcRenderer.send("gallery:close"),
  galleryEnabled: (on) => ipcRenderer.send("gallery:enabled", on), // Features switch → HUD 🖼 button
  onGalleryEnabled: on("gallery:enabled"),
  orbEnabled: (on) => ipcRenderer.send("orb:enabled", on), // Features › Orb switch → HUD orb
  onOrbEnabled: on("orb:enabled"),
  orb: (input) => ipcRenderer.send("orb", input), // main window → HUD orb
  onOrb: on("orb"),
  onGallery: on("gallery"),
  galleryItem: (index) => ipcRenderer.invoke("gallery:item", index), // folder: go in, other file: open in its app
  galleryLook: (index) => ipcRenderer.send("gallery:look", index), // image in the viewer (-1 = none), for Iris
  onAudio: on("live:audio"),
  onInterrupt: on("live:interrupt"),
  onStatus: on("live:status"),
  onLog: on("live:log"),
  getHistory: () => ipcRenderer.invoke("live:history"), // recent live:log rows kept in main memory (chat window)
  onContext: on("live:context"), // { used, max, trimAt } once per turn, null after "↺ Làm mới"
  sendInput: (parts, label) => ipcRenderer.invoke("live:input", parts, label), // typed turn → true if sent
  clearContext: () => ipcRenderer.send("live:clear"), // "↺ Làm mới": a new session, same setup, mic and 👂 kept
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
  popout: () => ipcRenderer.send("popout"), // HUD 📷 and main window ⧉: open / close the "Iris Camera" window (hud.mjs openPop)
  onPopout: on("popout"),
  chat: (dock) => ipcRenderer.send("chat", dock), // HUD 💬: show / hide the chat window next to the dock rect { x, y, width, height }
  onChat: on("chat"),
});
