// HUD display only: tracking runs in the main window (engine.js), which sends its state here every frame via main ("hand").
// The camera preview (⌃⌥C) is this window's own stream of the same camera, open only while vision is on.
import { DrawingUtils, HandLandmarker } from "../../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs";
import { openVideo } from "../renderer/devices.js";

const $ = (id) => document.getElementById(id);
// Work-area insets from hud.mjs, so the corner panels stay off the menu bar and Dock.
for (const [k, v] of new URLSearchParams(location.search)) document.documentElement.style.setProperty(`--${k}`, v);

let vision = false;
let camera = false;
let cam = null; // Settings › Camera, same device as engine.js
let stream = null;
const POP = new URLSearchParams(location.search).has("pop"); // this page is the "Iris Camera" window
let popped = false; // an "Iris Camera" window is open: the HUD leaves the camera to it
const wanted = () => vision && (POP || (camera && !popped)); // the pop-out exists to show the camera: 📷 does not apply there
const bones = $("bones").getContext("2d");
const drawer = new DrawingUtils(bones);

async function syncCamera() {
  const want = wanted();
  $("view").hidden = !want;
  if (want && !stream) {
    stream = await openVideo({ width: 640, height: 480 }, cam);
    if (!wanted()) return syncCamera(); // switched off while the camera was opening
    $("cam").srcObject = stream;
  } else if (!want && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = $("cam").srcObject = null;
  }
}
const resync = () => syncCamera().catch((e) => console.error(`HUD camera: ${e.message}`));

window.gesture.onVision((on) => {
  vision = on;
  $("pose").hidden = !on;
  if (!on) show(null);
  resync();
});
window.gesture.onPopout((on) => ((popped = on), resync()));
window.gesture.onSettings((s) => {
  if (stream && s.cam?.id !== cam?.id) {
    stream.getTracks().forEach((t) => t.stop()); // another camera picked: drop this stream, syncCamera opens the new one
    stream = $("cam").srcObject = null;
  }
  cam = s.cam;
  camera = s.camera;
  resync();
});
// Language: hud-ui.js sets <html lang> and fires "langchange".
const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
let control = false;
// Shortcuts live in the HUD guide; here only the state, so the line stays short.
function showControl() {
  $("status").textContent = `● ${control ? tr("tay BẬT", "hand ON") : tr("tay TẮT", "hand OFF")}`;
  $("status").classList.toggle("on", control);
}
window.gesture.onControl((on) => ((control = on), showControl()));
document.addEventListener("langchange", showControl);

function show(s) {
  const ring = $("ring");
  ring.hidden = !s?.ring;
  if (s?.ring) {
    const { mode, x, y, progress, approach } = s.ring;
    ring.className = mode;
    ring.style.transform = `scale(${1.5 - approach})`; // shrinks from 1.5x to 0.5x as the fingers close in
    ring.style.background = progress ? `conic-gradient(rgba(255, 170, 0, 0.8) ${progress * 360}deg, transparent 0)` : "";
    // Same pixel the mouse helper gets (hud.mjs), minus where macOS put this window.
    ring.style.left = `${x * (screen.width - 1) - window.screenX}px`;
    ring.style.top = `${y * (screen.height - 1) - window.screenY}px`;
  }
  $("pose").textContent = s?.pose ?? tr("không thấy tay", "no hand");
  bones.clearRect(0, 0, 640, 480);
  if (s?.lm && stream) drawer.drawConnectors(s.lm, HandLandmarker.HAND_CONNECTIONS, { color: "#0f0", lineWidth: 3 });
  window.dispatchEvent(new CustomEvent("palms", { detail: s?.palms ?? null })); // two-hand zoom in hud-ui.js
}
window.gesture.onHand(show);
