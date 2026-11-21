// HUD buttons, transcript and gallery. Clicked with the hand mouse: the window is click-through
// except while the cursor is over the dock or the gallery is open (see hud:interactive in hud.mjs).
import { RING_SLOTS, ringFront, ringTo, ringTurn, palmGap, zoomTarget } from "./hand.js";
import { mountOrb } from "../renderer/orb.js";

const $ =(id) => document.getElementById(id);
// UI language = the main window's Ngôn ngữ select (config lang), read each time the HUD opens; it cannot change while the HUD is up.
const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
function setLang(lang) {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-en]")) el.textContent = tr((el.dataset.vi ??= el.textContent), el.dataset.en);
  for (const el of document.querySelectorAll("[data-en-title]")) el.title = tr((el.dataset.viTitle ??= el.title), el.dataset.enTitle);
  for (const el of document.querySelectorAll("[data-en-aria-label]")) el.ariaLabel = tr((el.dataset.viAriaLabel ??= el.ariaLabel), el.dataset.enAriaLabel);
  document.dispatchEvent(new Event("langchange")); // dynamic text re-renders itself (hud-view.js too)
}
const WHEEL_STEP = 120; // scroll px per card turn; the ✌ scroll sends a few tens of px per frame
const SNAP_MS = 150; // no wheel for this long = the hand stopped: settle on the nearest card

// The "Iris Camera" window (hud.mjs openPop) loads this page with ?pop: only the camera panel, no overlay duties.
const POP = new URLSearchParams(location.search).has("pop");
if (POP) {
  document.body.classList.add("pop");
  $("dock").hidden = false;
  window.iris.getConfig().then((c) => setLang(c.lang));
}

let overDock = false;
const interactive = () => {
  if (POP) return; // a normal window: click-through and the gallery belong to the overlay
  window.gesture.interactive(overDock || !$("gallery").hidden);
  window.gesture.hudGallery(!$("gallery").hidden); // the engine (main window) zooms with two hands only while it is open
};
for (const id of ["dock"]) {
  $(id).onmouseenter = () => ((overDock = true), interactive());
  $(id).onmouseleave = () => ((overDock = false), interactive());
}

// HUD orb: drawn here, driven by the main window (orb-ui.js), which owns the mic and the playback.
const orb = POP ? null : mountOrb($("hud-orb"));
window.iris.onOrb((input) => orb?.set(input));
window.iris.onOrbEnabled((on) => ($("hud-orb").hidden = !on));

// Iris on/off, mic mute and listen-only. The main window runs Start/Stop with its own session/model/voice/tool picks.
let live = "offline";
let muted = false;
let listenOnly = false;
function showButtons() {
  const on = live !== "offline";
  $("b-iris").textContent = on ? "⏹" : "🎙";
  $("b-iris").title = on ? `${tr("Dừng Iris", "Stop Iris")} · ${live}` : tr("Bật Iris", "Start Iris");
  $("b-iris").classList.toggle("on", on);
  $("b-mute").textContent = muted ? "🔇" : "🎤";
  $("b-mute").title = muted ? tr("Bật mic", "Unmute the mic") : tr("Tắt mic", "Mute the mic");
  $("b-mute").classList.toggle("on", on && !muted);
  $("b-mute").disabled = !on;
  $("b-listen").title = listenOnly ? tr("Đang chỉ nghe: bấm để Iris nói lại", "Listening only: click to let Iris speak again") : tr("Chỉ nghe: Iris nghe nhưng không nói", "Listen only: Iris listens but does not speak");
  $("b-listen").classList.toggle("on", on && listenOnly);
  $("b-listen").disabled = !on;
  showSend();
}
window.iris.getState().then((s) => ((live = s.status), (muted = s.muted), (listenOnly = s.listenOnly), showButtons()));
window.iris.onStatus((s) => ((live = s), showButtons()));
window.iris.onMute((m) => ((muted = m), showButtons()));
window.iris.onListen((on) => ((listenOnly = on), showButtons()));
$("b-iris").onclick = () => window.iris.toggle();
$("b-mute").onclick = () => window.iris.mute(!muted);
$("b-listen").onclick = () => window.iris.listen(!listenOnly);
// 📷 opens / closes the "Iris Camera" window (hud.mjs openPop). ⌃⌥C still toggles the small preview in the dock.
window.gesture.onPopout((on) => $("b-cam").classList.toggle("on", on));
$("b-cam").onclick = () => window.gesture.popout();
$("b-exit").onclick = () => window.gesture.hud(false); // back to the main window (hud.mjs setDock shows it)

// No conversation on the HUD itself: 💬 opens the chat window (hud.mjs openChat) when it is needed.
$("b-talk").onclick = () => {
  const { x, y, width, height } = $("dock").getBoundingClientRect();
  window.gesture.chat({ x, y, width, height });
};
window.gesture.onChat((open) => $("b-talk").classList.toggle("on", open));

// Gallery View: every folder entry is a card. ✌ scroll turns the ring one card per WHEEL_STEP, click brings a card to the front,
// double-click opens it like Finder: image = viewer, folder/⬆ = go there, other file = its macOS app (main).
// Two hands zoom anywhere in the gallery (ring or viewer); the viewer pans with ✌. ✕ or a right click (🤏 thumb+middle) goes back.
// While an image is in the viewer, main tells Iris its path, so the user can just say what to do with "ảnh này".
const overlay = $("gallery");
let cards = [];
let items = [];
let step = 0; // degrees per card
let turned = 0; // cards turned so far, fractional while ✌ scrolls; not wrapped, so the ring never spins the long way round
let snap = 0;
const arc = () => cards.length < RING_SLOTS; // few cards sit side by side on an arc, see ringTurn
const front = () => ringFront(turned, cards.length);

// Main opens it and sends it back via "gallery"; an unreadable folder throws, its reason goes to the status line.
$("b-gallery").onclick = () =>
  window.iris.openGallery().then((why) => why && ($("status").textContent = tr("Không mở được gallery: ", "Could not open the gallery: ") + why))
    .catch((e) => ($("status").textContent = tr("Không mở được gallery: ", "Could not open the gallery: ") + e.message));
window.iris.onGalleryEnabled((on) => ($("b-gallery").hidden = !on)); // only while Features › Gallery View is on
window.iris.onGallery((g) => POP || (g ? show(g) : overlay.hidden || close()));
window.gesture.onHud((on) => {
  if (POP) return;
  $("dock").hidden = $("odock").hidden = !on;
  if (on) window.iris.getConfig().then((c) => setLang(c.lang));
});
document.addEventListener("langchange", showButtons);
$("gclose").onclick = close;
// Right click only leaves the viewer: a stray 🤏 middle pinch (e.g. opening a ✊) must never close the gallery, only ✕ does.
overlay.oncontextmenu = () => void (viewer.hidden || back());

const ICON = { dir: "📁", up: "⬆", file: "📄" };
let hint = "";

function show(g) {
  if (!g) return;
  if (!viewer.hidden) back(); // a new folder replaces whatever was being viewed
  items = g.items;
  const n = items.length;
  step = 360 / Math.max(n, RING_SLOTS);
  const cw = Math.round(Math.min(innerWidth * 0.4, innerHeight * 0.7)); // card width: as big as the screen allows, 4:3 image
  $("cards").style.setProperty("--cw", `${cw}px`);
  const radius = Math.round(cw / 2 / Math.tan(Math.PI / Math.max(n, RING_SLOTS))) + 40;
  cards = items.map((it, i) => {
    const el = document.createElement("figure");
    el.className = `card ${it.kind}`;
    el.style.transform = `rotateY(${i * step}deg) translateZ(${radius}px)`;
    let pic;
    if (it.url) {
      pic = document.createElement("img");
      pic.src = it.url;
      pic.alt = "";
      pic.loading = "lazy";
    } else {
      pic = document.createElement("div");
      pic.className = "icon";
      pic.textContent = ICON[it.kind];
      if (it.kind === "file") pic.dataset.ext = it.name.includes(".") ? it.name.split(".").pop() : "";
    }
    const cap = document.createElement("figcaption");
    cap.textContent = it.kind === "up" ? `${tr("Lên", "Up")}: ${it.name}` : it.name;
    el.append(pic, cap);
    el.onclick = () => turnTo(i);
    el.ondblclick = () => openCard(i);
    return el;
  });
  $("cards").replaceChildren(...cards);
  $("cards").dataset.radius = radius;
  turned = 0;
  const up = items.findIndex((it) => it.kind === "up");
  $("gup").hidden = up < 0; // none at ~/ (the top) or the disk root
  $("gup").onclick = $("gback").onclick = () => openCard(up);
  $("gback").disabled = up < 0;
  hint = n === (up < 0 ? 0 : 1)
    ? `${g.folder}: ${tr("thư mục trống. Bấm ⬆ để quay lên, ✕ để đóng.", "empty folder. Press ⬆ to go up, ✕ to close.")}`
    : `${g.folder}${g.more > 0 ? ` (${tr("ẩn", "hiding")} ${g.more} ${tr("mục", "items")})` : ""}: ${tr("✌ cuộn để xoay, chụm để chọn thẻ, chụm 2 lần để mở, ⬆ lên thư mục cha, ➤ gửi thẻ cho Iris, ✕ để đóng.", "✌ scroll to turn, pinch to pick a card, pinch twice to open, ⬆ parent folder, ➤ send the card to Iris, ✕ to close.")}`;
  $("ghint").textContent = hint;
  overlay.hidden = false;
  setZoom(1);
  interactive();
  turn(0);
  if (g.open >= 0) (turnTo(g.open), view(g.open)); // a single image was opened
}

async function openCard(i) {
  turnTo(i);
  if (items[i].kind === "image") return view(i);
  const why = await window.iris.galleryItem(i).catch((e) => e.message); // a folder comes back as a new "gallery"; unreadable folders throw
  $("ghint").textContent = why ? `${tr("Không mở được", "Could not open")} ${items[i].name}: ${why}` : hint;
}

function turn(d) {
  if (!cards.length) return;
  turned = ringTurn(turned, d, cards.length);
  $("cards").style.transform = `translateZ(-${$("cards").dataset.radius}px) rotateY(${-turned * step}deg)`;
  const f = front();
  const n = cards.length;
  cards.forEach((c, i) => {
    const dist = arc() ? Math.abs(i - f) : Math.min((i - f + n) % n, (f - i + n) % n);
    c.style.opacity = Math.max(0.15, 1 - dist * 0.3);
    c.classList.toggle("front", i === f);
  });
  showSend();
}

// ➤ sends only the card's path (main does it, silently); dimmed while Iris is offline, never for the ⬆ card.
function showSend() {
  const off = live === "offline";
  for (const id of ["gsend", "vsend"]) {
    $(id).disabled = off;
    $(id).title = off ? tr("Iris chưa chạy", "Iris is not running") : tr("Gửi đường dẫn thẻ này cho Iris", "Send this card's path to Iris");
  }
  const it = items[front()];
  if (!it || it.kind === "up") $("gsend").disabled = true;
}

let sentTimer = 0;
async function send(i) {
  if (!(await window.iris.gallerySend(i).catch(() => false))) return;
  const name = items[i].name;
  $("gsent").textContent = tr(`Đã gửi "${name}" cho Iris: nói Iris cần làm gì`, `Sent "${name}" to Iris: tell Iris what to do`);
  $("gsent").hidden = false;
  clearTimeout(sentTimer);
  sentTimer = setTimeout(() => ($("gsent").hidden = true), 4000);
}
$("gsend").onclick = () => send(front());
$("vsend").onclick = () => send(viewing);

const turnTo = (i) => turn(ringTo(turned, i, cards.length));

overlay.addEventListener("wheel", (e) => {
  if (!viewer.hidden) return pan(e.deltaX, e.deltaY);
  // The ring follows the hand continuously; whole-card jumps each restarting the 0.3s ease looked jerky.
  $("cards").classList.add("live");
  turn((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / WHEEL_STEP);
  clearTimeout(snap);
  snap = setTimeout(() => ($("cards").classList.remove("live"), turn(Math.round(turned) - turned)), SNAP_MS);
});

function close() {
  back();
  overlay.hidden = true;
  interactive();
}

// Zoom = zoom when both hands appeared × how much further apart they are now; the hands leaving keeps the zoom.
// Ring and viewer each start at 1×.
const viewer = $("viewer");
const ZOOM_MAX = 6;
let viewing = -1;
let zoom = 1;
let at = { x: 0, y: 0 }; // pan in px
let grab = null; // { dist, zoom } when the two hands appeared

function view(i) {
  viewing = i;
  $("big").src = items[i].url;
  viewer.hidden = false;
  setZoom(1);
  window.iris.galleryLook(i);
}

function back() {
  if (!viewer.hidden) window.iris.galleryLook(-1);
  viewer.hidden = true;
  setZoom(1);
}

function setZoom(z) {
  zoom = z;
  at = { x: 0, y: 0 };
  grab = null;
  place();
}

function place() {
  $("cards").style.scale = viewer.hidden ? zoom : 1; // `scale` composes with the ring's rotate transform
  $("big").style.transform = `translate(${at.x}px, ${at.y}px) scale(${zoom})`;
  $("vzoom").textContent = `${items[viewing]?.name ?? ""} · ${zoom.toFixed(1)}× · ${tr('2 tay kéo ra/chụm lại để zoom, ✌ để di chuyển · nói với Iris về "ảnh này"', '2 hands apart/together to zoom, ✌ to move · tell Iris about "this image"')}`;
}

function pan(dx, dy) {
  // Content follows the hand like dragging paper; never further than the zoomed image overhangs the screen.
  const lim = (v, size) => Math.max(-(size * (zoom - 1)) / 2, Math.min((size * (zoom - 1)) / 2, v));
  at = { x: lim(at.x - dx, innerWidth), y: lim(at.y - dy, innerHeight) };
  place();
}

window.addEventListener("palms", ({ detail: palms }) => {
  if (overlay.hidden || !palms) return void (grab = null);
  const gap = palmGap(palms);
  grab ??= { dist: gap, zoom };
  const target = zoomTarget(grab, gap, ZOOM_MAX);
  zoom += (target - zoom) * 0.3; // damp the hand jitter
  pan(0, 0); // re-clamp the pan to the new zoom
});

$("vback").onclick = back;
