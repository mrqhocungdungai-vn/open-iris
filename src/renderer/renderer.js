// Mic capture + gapless playback, ported from myiris src/hooks/useAudioPipeline.ts.
const $ = (id) => document.getElementById(id);
// UI language follows the Ngôn ngữ select (also Gemini's language). tr() picks a dynamic string; gesture/setup.js uses it too.
const tr = (vi, en) => (document.documentElement.lang === "en" ? en : vi);
function setLang(lang) {
  document.documentElement.lang = lang;
  // Static text: Vietnamese in index.html, English in data-en*; the Vietnamese is kept in data-vi* on first switch.
  for (const el of document.querySelectorAll("[data-en]")) {
    el.dataset.vi ??= el.textContent;
    el.textContent = tr(el.dataset.vi, el.dataset.en);
  }
  for (const a of ["title", "aria-label", "placeholder"])
    for (const el of document.querySelectorAll(`[data-en-${a}]`)) {
      if (!el.hasAttribute(`data-vi-${a}`)) el.setAttribute(`data-vi-${a}`, el.getAttribute(a));
      el.setAttribute(a, tr(el.getAttribute(`data-vi-${a}`), el.getAttribute(`data-en-${a}`)));
    }
  document.dispatchEvent(new Event("langchange")); // dynamic text re-renders itself
}
// One row per line, tagged you / iris / err / sys for styling; capped like the HUD transcript.
// Gemini speaks in chunks, one log line each; same-speaker chunks join one row, like the HUD transcript.
const log = (line) => {
  const who = /^(you|iris):/.exec(line)?.[0];
  const last = $("log").lastElementChild;
  if (who && last?.dataset.who === who) {
    last.textContent += line.slice(who.length + 1); // chunks carry their own spaces
    $("log").scrollTop = $("log").scrollHeight;
    return;
  }
  const row = document.createElement("div");
  if (who) row.dataset.who = who;
  row.className = /^(you|iris):/.exec(line)?.[1] ?? (/^error:|failed/.test(line) ? "err" : "sys");
  row.textContent = line;
  $("log").append(row);
  while ($("log").childElementCount > 200) $("log").firstChild.remove();
  $("log").scrollTop = $("log").scrollHeight; // conversation box keeps the newest line in view
};
// Start problems go next to the Start button, in words the user can act on; the raw line still goes to the log.
const showError = (what, e) => {
  const raw = e?.message || String(e);
  log(`${what} failed: ${raw}`);
  $("error").textContent =
    e?.name === "NotAllowedError" ? tr("Chưa cấp quyền micro. Mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật › Micro, bật cho app này rồi bấm Bắt đầu lại.", "No microphone permission. Open System Settings › Privacy & Security › Microphone, turn it on for this app, then press Start again.")
    : e?.name === "NotFoundError" ? tr("Không tìm thấy micro nào. Cắm hoặc bật micro rồi bấm Bắt đầu lại.", "No microphone found. Plug in or turn on a microphone, then press Start again.")
    : /GEMINI_API_KEY/.test(raw) ? tr("Chưa có khoá Gemini: ", "No Gemini key: ") + raw.replace(/^.*?(GEMINI_API_KEY)/, "$1")
    : tr(`Không thực hiện được (${what}): `, `Could not ${what}: `) + raw;
  $("error").hidden = false;
};

let mic = null; // { stream, context }
let out = null; // output AudioContext
let playhead = 0;
let sources = [];

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Settings › Micro (devices.js); a plain deviceId is "ideal", so an unplugged mic falls back to the default.
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...($("mic").value && { deviceId: $("mic").value }) },
  });
  document.dispatchEvent(new Event("devicesused")); // devices.js: labels are readable now
  // Gemini wants 16 kHz PCM; a 16 kHz context makes the browser resample the mic.
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule("mic-downsample.js");
  const node = new AudioWorkletNode(context, "mic-downsample");
  node.port.onmessage = ({ data }) => window.iris.sendAudio(data);
  context.createMediaStreamSource(stream).connect(node);
  mic = { stream, context };
  console.info(`mic started device="${stream.getAudioTracks()[0]?.label}" sampleRate=${context.sampleRate}`);
}

// A new mic pick while Iris runs: swap the stream, the session stays open.
$("mic").addEventListener("change", () => {
  if (!mic) return;
  stopMic();
  startMic().catch((e) => showError("start mic", e));
});

function stopMic() {
  if (mic) console.info("mic stopped");
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic?.context.close();
  mic = null;
}

function play({ data, mimeType }) {
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] || 24000);
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const n = bytes.byteLength >> 1;
  if (!n) return;
  out ??= new AudioContext();
  const buffer = out.createBuffer(1, n, rate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
  const src = out.createBufferSource();
  src.buffer = buffer;
  src.connect(out.destination);
  src.onended = () => (sources = sources.filter((s) => s !== src));
  // Queue chunks back-to-back so streamed audio plays gaplessly.
  const startAt = Math.max(out.currentTime + 0.03, playhead);
  src.start(startAt);
  playhead = startAt + buffer.duration;
  sources.push(src);
}

function flushPlayback() {
  sources.forEach((s) => s.stop());
  if (sources.length) console.debug(`playback flushed ${sources.length} queued chunks`);
  sources = [];
  playhead = 0;
}

// One checkbox per tool in config (main.mjs cleans the names); write tools default off.
const config = window.iris.getConfig();
config.then((c) => {
  // The lists live in main.mjs (its allowlists); only the labels are made here.
  const labelOf = { lang: (v) => ({ vi: "Tiếng Việt", en: "English" })[v] || v, model: (v) => v.replace(/^models\//, "") + (v.endsWith("flash-live-preview") ? " (legacy)" : ""), voice: (v) => v };
  for (const id of ["lang", "model", "voice"]) {
    $(id).replaceChildren(...c.options[id].map((v) => new Option(labelOf[id](v), v)));
    $(id).value = c[id];
  }
  setLang(c.lang);
  $("tools").append(Object.assign(document.createElement("strong"), { textContent: groupName() }));
  for (const [name, on] of Object.entries(c.tools)) {
    const label = document.createElement("label");
    label.lang = "en"; // tool ids stay English
    label.innerHTML = `<input type="checkbox" role="switch" name="${name}"> ${name}`;
    label.firstChild.checked = on;
    $("tools").append(label);
  }
  $("owner").value = c.owner;
  for (const { name, description } of c.options.skills) {
    // SKILL.md text is the owner's file: textContent only, never innerHTML.
    const label = document.createElement("label");
    label.className = "feature";
    const box = Object.assign(document.createElement("input"), { type: "checkbox", name, checked: c.skills[name] ?? true });
    box.setAttribute("role", "switch");
    const text = document.createElement("span");
    const small = document.createElement("small");
    small.textContent = description;
    const id = Object.assign(document.createElement("span"), { lang: "en", textContent: name + " " }); // description keeps the page language
    text.append(id, small);
    label.append(box, " ", text);
    $("skills").append(label);
  }
});
const groupName = () => tr("Điều khiển máy tính (agent-desktop)", "Computer control (agent-desktop)");
$("lang").onchange = () => (setLang($("lang").value), window.iris.saveLang($("lang").value));
document.addEventListener("langchange", () => {
  document.querySelectorAll("#tools strong").forEach((h) => (h.textContent = groupName()));
  $("owner-state").textContent = "";
  $("topic-state").textContent = "";
  showListen();
  for (const id of ["guide-link", "hud-guide-link", "gallery-guide-link"]) $(id).search = "?lang=" + document.documentElement.lang;
  showStatus();
  showMute();
  $("toggle").textContent = mic ? tr("Dừng", "Stop") : tr("Bắt đầu", "Start");
});
$("owner-save").onclick = async () => {
  try {
    await window.iris.saveOwner($("owner").value);
    $("owner-state").textContent = tr("Đã lưu", "Saved");
  } catch (e) {
    showError("save IRIS.md", e);
  }
};
$("owner").oninput = () => ($("owner-state").textContent = "");
$("skills-open").onclick = async () => {
  const err = await window.iris.openSkills();
  if (err) showError("open skills", new Error(err));
};
// Features › Livestream: saved right away, read by main.mjs at the next Start.
const liveIds = ["cohost", "recap", "live-topic", "topic-save"];
const showLive = () => ($("live-box").hidden = !$("cohost").checked);
config.then((c) => {
  $("cohost").checked = c.cohost;
  $("recap").checked = c.recap;
  $("live-topic").value = c.topic;
  showLive();
});
$("cohost").onchange = () => (window.iris.saveLive({ cohost: $("cohost").checked }), showLive());
$("recap").onchange = () => window.iris.saveLive({ recap: $("recap").checked });
$("topic-save").onclick = async () => {
  try {
    await window.iris.saveLive({ topic: $("live-topic").value });
    $("topic-state").textContent = tr("Đã lưu. Có hiệu lực từ lần Bắt đầu kế tiếp.", "Saved. Takes effect at the next Start.");
  } catch (e) {
    showError("save topic", e);
  }
};
$("live-topic").oninput = () => ($("topic-state").textContent = "");
$("t-talk").onchange = () => ($("log").scrollTop = $("log").scrollHeight); // a hidden tab ignores scrollTop, so catch up on return

const toolBoxes = () => [...document.querySelectorAll("#tools input")];
const skillBoxes = () => [...document.querySelectorAll("#skills input")];

window.iris.onAudio(play);
window.iris.onInterrupt(flushPlayback);
window.iris.onLog(log);
const showStatus = () => {
  const s = $("status").dataset.state;
  $("status").textContent = { offline: tr("Chưa chạy", "Not running"), connecting: tr("Đang kết nối…", "Connecting…"), listening: listenOnly ? tr("Chỉ nghe", "Listening only") : tr("Đang nghe", "Listening"), speaking: tr("Iris đang nói", "Iris is speaking") }[s] ?? s;
};
window.iris.onStatus((status) => {
  $("status").dataset.state = status; // colours the dot
  showStatus();
  $("mute").disabled = $("listen").disabled = status === "offline";
  if (status === "offline") {
    stopMic();
    $("toggle").textContent = tr("Bắt đầu", "Start");
    for (const id of ["lang", "model", "voice"]) $(id).disabled = false;
    liveIds.forEach((id) => ($(id).disabled = false));
    toolBoxes().forEach((b) => (b.disabled = false));
    skillBoxes().forEach((b) => (b.disabled = false));
  }
});

window.iris.onToggle(() => $("toggle").click()); // 🎙 on the HUD
// Mic mute: main.mjs drops the mic chunks, the session stays open; the HUD 🎤 button shares this state.
let muted = false;
const showMute = () => ($("mute").textContent = muted ? tr("🔇 Mic tắt", "🔇 Mic off") : "🎤 Mic");
window.iris.onMute((m) => ((muted = m), showMute()));
$("mute").onclick = () => window.iris.mute(!muted);
// Listen-only: main.mjs drops Iris's audio and refuses tools; the HUD 👂 button shares this state.
let listenOnly = false;
function showListen() {
  $("listen").textContent = listenOnly ? tr("👂 Đang chỉ nghe", "👂 Listening only") : tr("👂 Chỉ nghe", "👂 Listen only");
  $("listen").ariaPressed = listenOnly;
}
window.iris.onListen((on) => ((listenOnly = on), showListen(), showStatus()));
$("listen").onclick = () => window.iris.listen(!listenOnly);
$("toggle").onclick = async () => {
  if (mic) return window.iris.stop();
  // No second click while starting: it would race the first start.
  $("toggle").disabled = true;
  $("error").hidden = true;
  try {
    await start();
  } finally {
    $("toggle").disabled = false;
  }
};

async function start() {
  try {
    const opts = {};
    for (const id of liveIds) $(id).disabled = true;
    for (const id of ["lang", "model", "voice"]) {
      $(id).disabled = true;
      opts[id] = $(id).value;
    }
    opts.tools = Object.fromEntries(toolBoxes().map((b) => ((b.disabled = true), [b.name, b.checked])));
    opts.skills = Object.fromEntries(skillBoxes().map((b) => ((b.disabled = true), [b.name, b.checked])));
    await window.iris.start(opts);
    await startMic();
    $("toggle").textContent = tr("Dừng", "Stop");
  } catch (e) {
    console.error(`start failed: ${e?.stack || e}`);
    showError("start", e);
    window.iris.stop();
  }
}
