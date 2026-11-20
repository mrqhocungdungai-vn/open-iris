// Manual input box (#compose) under the conversation: typed text, images and text files go to Iris as one turn.
// Its own switch (#compose-on); drops on the box attach, drops elsewhere still open the Gallery (gesture/setup.js).
// The HUD 💬 chat window (gesture/chat.html) loads this file too, with the same ids plus 📋 #paste and without the switch.
import { classify, buildParts } from "./compose-view.mjs";

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.lang;
const tr = (vi, en) => (lang() === "en" ? en : vi);
let items = [], status = "offline", on = true, sending = false;

const b64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function add(files) {
  for (const f of files) {
    const c = classify(f, lang());
    const it = { name: f.name, ...c };
    if (c.kind === "image") Object.assign(it, { mimeType: f.type, data: await b64(f), url: URL.createObjectURL(f) });
    if (c.kind === "text") it.content = await f.text();
    items.push(it);
  }
  render();
}

function render() {
  const live = status !== "offline" && status !== "connecting";
  $("compose").hidden = !on;
  for (const id of ["attach", "paste", "say", "say-send"]) if ($(id)) $(id).disabled = !live || sending;
  $("say").placeholder = live ? tr("Gõ cho Iris… (Enter gửi, Shift+Enter xuống dòng)", "Type to Iris… (Enter sends, Shift+Enter new line)") : tr("Bấm Bắt đầu để gõ cho Iris", "Press Start to type to Iris");
  $("chips").replaceChildren(...items.map((it, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    if (it.kind === "bad") chip.dataset.bad = "";
    if (it.url) chip.append(Object.assign(document.createElement("img"), { src: it.url, alt: "" }));
    chip.append((it.kind === "text" ? "📄 " : it.kind === "bad" ? "⚠ " : "") + it.name + (it.why ? `: ${it.why}` : ""));
    const x = Object.assign(document.createElement("button"), { type: "button", textContent: "×", ariaLabel: tr("Bỏ", "Remove") });
    x.onclick = () => { if (it.url) URL.revokeObjectURL(it.url); items.splice(i, 1); render(); };
    chip.append(" ", x);
    return chip;
  }));
}

async function sendNow() {
  const text = $("say").value, good = items.filter((it) => it.kind !== "bad");
  const parts = buildParts(text, good);
  if (!parts.length || sending) return;
  sending = true; render();
  const label = [text.trim(), ...good.map((it) => "📎 " + it.name)].filter(Boolean).join("  ");
  const ok = await window.iris.sendInput(parts, label).catch(() => false);
  sending = false;
  if (ok) { items.forEach((it) => it.url && URL.revokeObjectURL(it.url)); items = []; $("say").value = ""; }
  else { $("error").textContent = tr("Không gửi được cho Iris.", "Could not send to Iris."); $("error").hidden = false; }
  render();
  $("say").focus();
}

$("compose").onsubmit = (e) => { e.preventDefault(); sendNow(); };
$("say").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendNow(); } }; // isComposing: Vietnamese IME
$("attach").onclick = () => $("attach-in").click();
$("attach-in").onchange = () => { add([...$("attach-in").files]); $("attach-in").value = ""; };
// ⌘V of a copied image or file attaches it; plain text pastes as usual.
$("say").onpaste = (e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); add(files); } };
// 📋 (chat window only): the clipboard image without a keyboard, for the hand mouse.
if ($("paste")) $("paste").onclick = async () => {
  const files = [];
  try {
    for (const it of await navigator.clipboard.read())
      for (const t of it.types) if (t.startsWith("image/")) files.push(new File([await it.getType(t)], `clipboard.${t.split("/")[1]}`, { type: t }));
  } catch (e) { console.warn("clipboard read failed:", e.message); }
  if (files.length) add(files);
  else { $("error").textContent = tr("Clipboard không có ảnh.", "No image on the clipboard."); $("error").hidden = false; }
};
// stopPropagation keeps the document-level Gallery drop from also firing.
$("compose").ondragover = (e) => { e.preventDefault(); e.stopPropagation(); $("compose").dataset.drop = ""; };
$("compose").ondragleave = () => delete $("compose").dataset.drop;
$("compose").ondrop = (e) => {
  e.preventDefault(); e.stopPropagation();
  delete $("compose").dataset.drop;
  if (!$("say").disabled) add([...e.dataTransfer.files]);
};

window.iris.onStatus((s) => ((status = s), render()));
window.iris.getState().then((s) => ((status = s.status), render())); // the chat window opens mid-session
window.iris.getConfig().then((c) => { on = c.compose; if ($("compose-on")) $("compose-on").checked = on; render(); });
if ($("compose-on")) $("compose-on").onchange = () => { on = $("compose-on").checked; window.iris.saveCompose(on); render(); };
document.addEventListener("langchange", render);
render();
