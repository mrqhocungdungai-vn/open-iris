// The 💬 chat window (chat.html): conversation + input box. Opened and hidden by the HUD 💬 / ✕ / Esc, never always on.
import { addLine } from "./talk.js";
import "../renderer/compose-ui.js"; // the input box: same ids, same Features switch (config.compose)

const $ = (id) => document.getElementById(id);
const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
window.iris.getConfig().then((c) => {
  document.documentElement.lang = c.lang;
  for (const el of document.querySelectorAll("[data-en]")) el.textContent = tr(el.textContent, el.dataset.en);
  for (const el of document.querySelectorAll("[data-en-title]")) el.title = tr(el.title, el.dataset.enTitle);
  for (const el of document.querySelectorAll("[data-en-aria-label]")) el.ariaLabel = tr(el.ariaLabel, el.dataset.enAriaLabel);
  $("talk").dataset.empty = tr($("talk").dataset.empty, $("talk").dataset.enEmpty);
  document.dispatchEvent(new Event("langchange")); // compose-ui re-renders its placeholder
});

// Lines that arrive before the history reply are already in it (main stores before it sends), so they are skipped.
let ready = false;
window.iris.onLog((line) => ready && addLine($("talk"), line));
window.iris.getHistory().then((rows) => { for (const r of rows) addLine($("talk"), r); ready = true; });
const hide = () => window.gesture.chat();
$("close").onclick = hide;
document.addEventListener("keydown", (e) => e.key === "Escape" && !e.isComposing && hide());
window.gesture.onChat((open) => { if (open) { $("talk").scrollTop = $("talk").scrollHeight; $("say").focus(); } });
