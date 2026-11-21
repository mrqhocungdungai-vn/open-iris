// Settings › Micro / Camera. A choice is { id, label } or null (system default). The label is kept so an unplugged device
// still shows its name. Mic → config.json (renderer.js startMic reads #mic), camera → gesture.json (engine.js, HUD).
// The pure helpers are also imported by main.mjs and hud.mjs to check what comes over IPC.

// IPC/file trust boundary: anything else becomes null (system default).
export function cleanDevice(d) {
  const ok = (s) => typeof s === "string" && s.length > 0 && s.length <= 300;
  return d && ok(d.id) && (d.label === "" || ok(d.label)) ? { id: d.id, label: d.label } : null;
}

// <option> list: system default first, then the devices; the saved one stays listed when it is unplugged.
// macOS hides labels until the page has used that kind of device once, so those get "Micro 1", "Camera 2"…
export function deviceChoices(devices, kind, saved, tr) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId && !["default", "communications"].includes(d.deviceId));
  const word = kind === "audioinput" ? "Micro" : "Camera";
  const opts = [{ value: "", label: tr("Mặc định hệ thống", "System default") }, ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `${word} ${i + 1}` }))];
  if (saved && !list.some((d) => d.deviceId === saved.id))
    opts.push({ value: saved.id, label: `${saved.label || word} (${tr("không kết nối", "not connected")})` });
  return opts;
}

// Opens the picked camera. exact: an "ideal" deviceId lost to the system default (OBS Virtual Camera) like the mic did
// (renderer.js startMic). Only a camera that is gone falls back to the default.
export async function openVideo(base, choice, media = navigator.mediaDevices) {
  if (!choice) return media.getUserMedia({ video: base });
  try {
    return await media.getUserMedia({ video: { ...base, deviceId: { exact: choice.id } } });
  } catch (e) {
    if (!["OverconstrainedError", "NotFoundError"].includes(e?.name)) throw e;
    console.warn(`camera "${choice.label}" not available (${e.name}), using the system default`);
    return media.getUserMedia({ video: base });
  }
}

function initDevices() {
  const $ = (id) => document.getElementById(id);
  const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
  let mic = null;
  let cam = null;
  let devices = [];
  const show = () => {
    for (const [id, kind, saved] of [["mic", "audioinput", mic], ["cam", "videoinput", cam]]) {
      $(id).replaceChildren(...deviceChoices(devices, kind, saved, tr).map((o) => new Option(o.label, o.value)));
      $(id).value = saved?.id ?? "";
    }
  };
  const refresh = async () => {
    devices = await navigator.mediaDevices.enumerateDevices();
    show();
  };
  const choice = (id) => ($(id).value ? { id: $(id).value, label: $(id).selectedOptions[0].textContent.replace(/ \((không kết nối|not connected)\)$/, "") } : null);
  $("mic").onchange = () => {
    mic = choice("mic");
    window.iris.saveMic(mic); // renderer.js restarts a running mic on this same change event
  };
  $("cam").onchange = () => window.gesture.setSettings({ cam: choice("cam") }); // echoes back through onSettings
  window.gesture.onSettings((s) => ((cam = s.cam), show()));
  Promise.all([window.iris.getConfig(), window.gesture.getSettings()]).then(([c, s]) => ((mic = c.mic), (cam = s.cam), refresh()));
  navigator.mediaDevices.addEventListener("devicechange", refresh);
  // Labels appear once the mic or camera has been used: renderer.js and engine.js fire "devicesused" after opening one.
  document.addEventListener("devicesused", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("langchange", show);
}
// Only the main window has the pickers; the HUD imports this file just for openVideo.
if (globalThis.document?.getElementById("mic")) initDevices();
