// The 💬 chat window (chat.html): conversation + input box. Opened and hidden by the HUD 💬 / ✕ / Esc, never always on.
import "../renderer/convo-ui.js"; // the conversation turns, same as the main window
import "../renderer/compose-ui.js"; // the input box: same ids, same Features switch (config.compose)

const $ = (id) => document.getElementById(id);
const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
window.iris.getConfig().then((c) => {
  document.documentElement.lang = c.lang;
  for (const el of document.querySelectorAll("[data-en]")) el.textContent = tr(el.textContent, el.dataset.en);
  for (const el of document.querySelectorAll("[data-en-title]")) el.title = tr(el.title, el.dataset.enTitle);
  for (const el of document.querySelectorAll("[data-en-aria-label]")) el.ariaLabel = tr(el.ariaLabel, el.dataset.enAriaLabel);
  $("log").dataset.empty = tr($("log").dataset.empty, $("log").dataset.enEmpty);
  document.dispatchEvent(new Event("langchange")); // compose-ui re-renders its placeholder
});

const hide = () => window.gesture.chat();
$("close").onclick = hide;
document.addEventListener("keydown", (e) => e.key === "Escape" && !e.isComposing && hide());
window.gesture.onChat((open) => { if (open) { $("log").scrollTop = $("log").scrollHeight; $("say").focus(); } });
