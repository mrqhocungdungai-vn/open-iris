// Conversation DOM for the main window (#p-talk) and the 💬 chat window: both have #log (the turn list) and #log-jump.
// Turns come from convo-view.mjs. textContent only, never innerHTML: transcripts and tool errors can carry screen text.
// A page can add a local event (a Start error) with document.dispatchEvent(new CustomEvent("convo:local", { detail: event })).
import { reduce } from "./convo-view.mjs";

const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function tool(x) {
  const li = el("li", x.state);
  const name = el("span", "name", x.name);
  name.lang = "en"; // tool names are English identifiers
  const state = el("span", "visually-hidden", { run: tr(" đang chạy", " running"), ok: tr(" xong", " done"), fail: tr(" lỗi", " failed") }[x.state]);
  const ms = x.state !== "run" && x.ms >= 1000 ? el("span", "ms", `${(x.ms / 1000).toFixed(1)} s`) : null;
  const parts = [name, state, ...(ms ? [ms] : [])];
  if (x.state === "fail" && x.error) {
    const d = el("details"), s = el("summary");
    s.append(...parts);
    d.append(s, el("span", "reason", x.error));
    li.append(d);
  } else li.append(...parts);
  if (x.source !== "desktop") li.append(el("span", "src", x.source));
  return li;
}

function buildTurn(t) {
  if (t.kind === "error") return el("p", "err", t.text);
  if (t.kind === "session") {
    if (t.phase === "renewed") return el("p", "divider", tr("Phiên mới", "New session"));
    const why = [t.code, t.reason].filter(Boolean).join(": ");
    return el("p", "divider", tr("Phiên đã kết thúc", "Session ended") + (why ? ` (${why})` : ""));
  }
  const row = el("div", `turn ${t.kind}`);
  row.append(el("span", "who", t.kind === "you" ? tr("Bạn", "You") : "Iris"));
  if (t.kind === "you") {
    const p = el("p"), via = el("span", `via ${t.via === "typed" ? "key" : t.via === "gallery" ? "gallery" : "mic"}`);
    via.role = "img";
    if (t.via === "gallery") via.textContent = { folder: "📁", file: "📄", image: "🖼" }[t.files[0]?.kind] || "📄"; // the Gallery card's emoji
    via.ariaLabel = t.via === "typed" ? tr("gõ:", "typed:") : t.via === "gallery" ? tr("gửi từ Gallery:", "sent from Gallery:") : tr("nói:", "spoken:");
    p.append(via, t.via === "gallery" ? tr("Đã gửi từ Gallery", "Sent from Gallery") : t.text);
    row.append(p);
    if (t.files.length) {
      const ul = el("ul", "files");
      for (const f of t.files) ul.append(el("li", f.kind, f.name));
      row.append(ul);
    }
    return row;
  }
  if (t.tools.length) {
    const ul = el("ul", "acts");
    ul.ariaLabel = tr("Công cụ", "Tools");
    ul.append(...t.tools.map(tool));
    row.append(ul);
  }
  const p = el("p", null, t.text);
  if (t.interrupted) p.append(el("span", "cut", tr("bị ngắt", "cut off")));
  if (!t.done) {
    row.classList.add("open");
    const bars = el("span", "speaking");
    bars.ariaHidden = "true";
    bars.append(el("i"), el("i"), el("i"));
    p.append(bars);
  }
  row.append(p);
  return row;
}

const list = document.getElementById("log"), jump = document.getElementById("log-jump");
let turns = [], ready = false, els = new WeakMap();
const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 24;

// One element per turn object (turns are immutable), so only changed turns are rebuilt.
function render() {
  const follow = atEnd();
  const want = turns.map((t) => els.get(t) ?? els.set(t, buildTurn(t)).get(t));
  const keep = new Set(want);
  for (const c of [...list.children]) if (!keep.has(c)) c.remove();
  want.forEach((e, i) => list.children[i] !== e && list.insertBefore(e, list.children[i] ?? null));
  if (follow) list.scrollTop = list.scrollHeight; // keep the newest in view only if the user was already there
  else if (jump.hidden) {
    // Sit just above the log's bottom edge, whatever is under it in the page (the compose box in the main window).
    jump.style.insetBlockEnd = `${jump.offsetParent ? jump.offsetParent.clientHeight - list.offsetTop - list.offsetHeight + 10 : 10}px`;
    jump.hidden = false;
  }
}
const apply = (e) => ((turns = reduce(turns, e)), render());

// Events that arrive before the history reply are already in it (main stores before it sends), so they are skipped.
window.iris.onEvent((e) => ready && apply(e));
window.iris.getHistory().then((h) => ((turns = h.reduce(reduce, turns)), (ready = true), render()));
document.addEventListener("convo:local", (e) => apply(e.detail));
document.addEventListener("langchange", () => ((els = new WeakMap()), list.replaceChildren(), render()));
window.iris.onStatus((s) => list.toggleAttribute("data-speaking", s === "speaking"));
list.addEventListener("scroll", () => atEnd() && (jump.hidden = true), { passive: true });
jump.onclick = () => ((list.scrollTop = list.scrollHeight), (jump.hidden = true));
