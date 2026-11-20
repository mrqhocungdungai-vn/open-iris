// Plugin tab (4th tab): one card per plugin from main's plugins:list. Hooks only this round (no skills, tools, gestures).
// main validates every patch; on/off and every_min apply at the next Start, fields at once.
import { clampEvery, eventLabel, fieldPatch, groupPatch, hearsSpeech, kindLabel, label, needsTrust, pluginPatch, t, toolPatch, toolsLine, toolsState, trustState } from "./plugins-view.mjs";

const $ = (id) => document.getElementById(id);
const lang = () => document.documentElement.lang;
const tr = (vi, en) => t(lang(), vi, en);
const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
};
const sw = (checked, onchange, name) => h("input", { type: "checkbox", role: "switch", checked, onchange, ariaLabel: name });

let plugins = [];

async function load() {
  try {
    plugins = await window.iris.listPlugins();
    $("plug-error").hidden = true;
  } catch (e) {
    plugins = [];
    $("plug-error").textContent = tr("Không đọc được danh sách plugin: ", "Could not read the plugins: ") + (e?.message || e);
    $("plug-error").hidden = false;
  }
  render();
}

async function save(patch) {
  try {
    await window.iris.savePlugin(patch);
  } catch (e) {
    $("plug-error").textContent = tr("Không lưu được: ", "Could not save: ") + (e?.message || e);
    $("plug-error").hidden = false;
  }
  await load(); // main is the source of truth: show what it kept after clamping
}

// Trust dialog: lists every command, its event/matcher and what it receives. Resolves true only on "Trust".
function askTrust(p) {
  const d = $("trust-dlg");
  $("td-name").textContent = p.name;
  $("td-list").replaceChildren(
    ...p.trust.commands.map((c) =>
      h("li", {}, h("code", { textContent: c.command }), h("br"),
        h("small", { textContent: `${c.tool ? `Tool ${p.name}__${c.tool}` : `${eventLabel(lang(), c.event)} (${c.event}${c.matcher ? ` · ${c.matcher}` : ""})`} · ${tr("nhận", "receives")}: ${c.receives}` }))),
  );
  $("td-speech").hidden = !hearsSpeech(p.trust);
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
}

// A switch that would start a command on an untrusted folder asks first; Cancel leaves it off.
async function turn(p, change, patch) {
  if (needsTrust(p, change)) {
    if (!(await askTrust(p))) return render();
    try {
      await window.iris.trustPlugin(p.name);
    } catch (e) {
      $("plug-error").textContent = tr("Không lưu được tin cậy: ", "Could not save the trust: ") + (e?.message || e);
      $("plug-error").hidden = false;
      return render();
    }
  }
  save(patch);
}

async function trustOnly(p) {
  if (!(await askTrust(p))) return;
  await window.iris.trustPlugin(p.name).catch((e) => (($("plug-error").textContent = String(e?.message || e)), ($("plug-error").hidden = false)));
  load();
}

function groupRow(p, g) {
  return h("div", { className: "group" },
    h("label", {}, sw(g.on, (e) => turn(p, { group: g.name, on: e.target.checked }, groupPatch(p, g, { on: e.target.checked })), label(lang(), g)), label(lang(), g)),
    h("span", { className: "ev", title: g.event, textContent: eventLabel(lang(), g.event) }),
    ...g.kinds.map((k) => h("span", { className: `ev kind-${k}`, textContent: kindLabel(lang(), k) })),
    g.event === "Tick" &&
      h("span", { className: "every" }, tr("mỗi ", "every "),
        h("input", { type: "number", min: 2, max: 60, value: g.every_min ?? g.every_min_default, ariaLabel: tr("Chu kỳ, phút", "Period, minutes"),
          onchange: (e) => save(groupPatch(p, g, { every_min: clampEvery(e.target.value, g.every_min_default ?? 5) })) }),
        tr(" phút", " min")),
    ...g.commands.map((c) => h("pre", { className: "cmd", textContent: `$ ${c}` })),
  );
}

function trustLine(p) {
  const state = trustState(p);
  if (state === "none") return null;
  const text = {
    ok: tr("✓ Đã tin cậy các lệnh của plugin này", "✓ This plugin's commands are trusted"),
    new: tr("⚠ Có lệnh chạy trên máy: cần tin cậy trước khi bật", "⚠ Runs commands on this Mac: trust it before turning them on"),
    changed: tr("⚠ Plugin đã thay đổi: cần tin cậy lại trước khi lệnh chạy", "⚠ The plugin changed: trust it again before its commands run"),
  }[state];
  return h("div", { className: `trust${state === "ok" ? "" : " need"}` }, text,
    state !== "ok" && h("button", { textContent: tr("Xem và tin cậy…", "Review and trust…"), onclick: () => trustOnly(p) }));
}

async function remove(p) {
  try {
    if (await window.iris.removePlugin(p.name)) status(tr("Đã gỡ: ", "Removed: ") + p.name + ".");
  } catch (e) {
    $("plug-error").textContent = tr("Không gỡ được: ", "Could not remove: ") + (e?.message || e);
    $("plug-error").hidden = false;
  }
  load();
}
const removeBtn = (p) => h("div", { className: "perm-actions" }, h("button", { textContent: tr("Gỡ plugin…", "Remove plugin…"), onclick: () => remove(p) }));

function card(p) {
  if (p.error)
    return h("div", { className: "plugin broken" }, h("b", { lang: "en", textContent: p.name }),
      h("p", { className: "more" }, h("small", { textContent: tr("Không nạp được: ", "Could not load: ") + p.error })), removeBtn(p));
  return h("div", { className: "plugin" },
    h("label", { className: "feature" }, sw(p.on, (e) => turn(p, { on: e.target.checked }, pluginPatch(p, e.target.checked)), p.name), " ",
      h("span", {}, h("span", { lang: "en", textContent: p.name }), " ", h("small", { textContent: [p.version, p.description].filter(Boolean).join(" · ") }))),
    toolsStrip(p),
    ...p.fields.map((f) =>
      h("label", { className: "row" }, h("span", { textContent: label(lang(), f) }),
        h("input", { type: "text", maxLength: f.max || 500, value: f.value ?? "", placeholder: f.hint ?? "", onchange: (e) => save(fieldPatch(p, f, e.target.value)) }))),
    p.groups.length > 0 && h("h3", { lang: "en", textContent: "Hooks" }),
    ...p.groups.map((g) => groupRow(p, g)),
    trustLine(p),
    p.groups.some((g) => g.kinds.includes("speak")) &&
      h("p", { className: "more" }, h("small", { textContent: tr("Iris chỉ nói khi không ai đang nói. Đang 👂 Chỉ nghe thì giữ lượt.", "Iris speaks only when nobody is talking. While 👂 Listen only is on, it waits.") })),
    removeBtn(p),
  );
}

// Settings › Agent Tools: one group per plugin with command tools. Off or untrusted: dimmed but still clickable (like the cards).
const TOOLS_WHY = {
  off: ["tắt", "off", "Plugin đang tắt nên Iris không có các tool này. Bật ở tab", "The plugin is off, so Iris does not get these tools. Turn it on in the"],
  new: ["chưa tin cậy", "not trusted", "Plugin chưa được tin cậy nên Iris không có các tool này. Xem và tin cậy ở tab", "The plugin is not trusted yet, so Iris does not get these tools. Review and trust it in the"],
  changed: ["chưa tin cậy", "not trusted", "File của plugin đã đổi từ lần bạn tin cậy, nên Iris không có các tool này. Xem lại và tin cậy lại ở tab", "The plugin's files changed since you trusted it, so Iris does not get these tools. Review and trust it again in the"],
};
const pill = (vi, en) => h("span", { className: "ev", textContent: tr(vi, en) });

function toolGroup(p) {
  const state = toolsState(p);
  const why = TOOLS_WHY[state];
  const el = h("div", { className: `pgroup${why ? " dim" : ""}` },
    h("strong", {}, h("span", { lang: "en", textContent: p.name }), why && h("span", { className: `ev${state === "off" ? "" : " need"}`, textContent: tr(why[0], why[1]) })),
    why && h("small", { className: "why" }, tr(why[2], why[3]) + " ",
      h("a", { href: "#", lang: "en", textContent: "Plugin", onclick: (e) => (e.preventDefault(), $("t-plug").click()) }), "."),
    ...p.tools.map((tool) =>
      h("label", {}, sw(tool.on, (e) => turn(p, { tool: tool.name, on: e.target.checked }, toolPatch(p, tool, e.target.checked)), label(lang(), tool)),
        h("span", {}, h("span", { textContent: label(lang(), tool) }), h("span", { className: "id", lang: "en", textContent: `${p.name}__${tool.name}` }),
          tool.late && pill("kết quả đến sau", "result comes later"),
          tool.confirm && pill("hỏi lại trước khi chạy", "asks before running")))),
  );
  el.dataset.plugin = p.name; // the card strip finds its group by this
  return el;
}

// Card strip → Settings › Agent Tools: switch tab, rebuild, then scroll to the plugin's group and flash it.
async function jumpToTools(p) {
  $("t-set").checked = true; // no change event: that would start a second load()
  await load();
  const g = [...$("plugin-tools").children].find((x) => x.dataset.plugin === p.name);
  if (!g) return;
  g.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  g.classList.add("flash");
  g.addEventListener("animationend", () => g.classList.remove("flash"), { once: true });
  g.querySelector("input")?.focus({ preventScroll: true });
}

function toolsStrip(p) {
  const line = toolsLine(lang(), p);
  return line && h("div", { className: `ptools${line.none ? " none" : ""}` }, h("span", { textContent: line.text }),
    h("a", { href: "#", textContent: line.link, onclick: (e) => (e.preventDefault(), jumpToTools(p)) }));
}

function render() {
  $("plugin-tools").replaceChildren(...plugins.filter((p) => !p.error && p.tools?.length).map(toolGroup));
  $("plugins").replaceChildren(
    ...(plugins.length ? plugins.map(card) : [h("p", { className: "more" }, h("small", { textContent: tr("Chưa có plugin nào.", "No plugins yet.") }))]),
  );
}

$("plugins-open").onclick = async () => {
  const err = await window.iris.openPlugins();
  $("plug-error").textContent = err;
  $("plug-error").hidden = !err;
};
// Add: scan a folder or a GitHub link, show what it holds, install only the ticked plugins (all start off).
const status = (text, bad = false) => {
  $("plug-added").textContent = text;
  $("plug-added").classList.toggle("bad", bad);
  $("plug-added").hidden = !text;
};
const busy = (on) => {
  for (const el of [$("plugins-add"), ...$("plug-url").elements]) el.disabled = on;
};

function showPick(scan) {
  const box = $("plug-pick");
  const ok = scan.plugins.filter((p) => !p.error);
  const go = h("button", { textContent: tr("Cài plugin đã chọn", "Install selected"), disabled: ok.length !== 1 });
  const ticks = scan.plugins.map((p) =>
    h("label", { className: `pick${p.error ? " bad" : ""}` },
      h("input", { type: "checkbox", value: p.path, disabled: !!p.error, checked: !p.error && ok.length === 1,
        onchange: () => (go.disabled = !box.querySelector("input:checked")) }),
      h("span", {}, h("b", { lang: "en", textContent: p.name }), " ",
        h("small", { textContent: p.error ? tr("không cài được: ", "cannot install: ") + p.error
          : [p.version, p.description, p.installed && tr("đã cài, sẽ thay bản cũ", "installed, will be replaced")].filter(Boolean).join(" · ") }))));
  go.onclick = () => finish([...box.querySelectorAll("input:checked")].map((i) => i.value));
  box.replaceChildren(
    h("p", { textContent: scan.plugins.length
      ? tr(`Tìm thấy ${scan.plugins.length} plugin trong `, `Found ${scan.plugins.length} plugin(s) in `) + scan.source + tr(". Chọn plugin để cài:", ". Pick the ones to install:")
      : tr("Không tìm thấy plugin nào trong ", "No plugins found in ") + scan.source + "." }),
    ...ticks,
    h("div", { className: "perm-actions" }, scan.plugins.length > 0 && go, h("button", { textContent: tr("Huỷ", "Cancel"), onclick: () => finish([]) })),
  );
  box.hidden = false;
  status("");
}

async function scan(run) {
  busy(true);
  status(tr("Đang tìm plugin…", "Looking for plugins…"));
  try {
    const r = await run();
    if (r.canceled) status("");
    else showPick(r);
  } catch (e) {
    status(tr("Không lấy được: ", "Could not get it: ") + String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), true);
  }
  busy(false);
}

async function finish(picks) {
  $("plug-pick").hidden = true;
  let r;
  try {
    r = await window.iris.installPlugins(picks);
  } catch (e) {
    r = { installed: [], errors: [{ name: "", error: e?.message || String(e) }] };
  }
  if (!picks.length) return status("");
  const lines = [];
  if (r.installed.length) lines.push(tr("Đã thêm (đang tắt): ", "Added (off): ") + r.installed.join(", ") + ".");
  for (const e of r.errors) lines.push(tr("Bỏ qua ", "Skipped ") + (e.name ? e.name + ": " : "") + e.error);
  status(lines.join("\n"), !r.installed.length);
  load();
}

$("plugins-add").onclick = () => scan(() => window.iris.scanPluginFolder());
$("plug-url").onsubmit = (e) => {
  e.preventDefault();
  scan(() => window.iris.scanPluginUrl($("plug-url-in").value));
};
// main rebuilds the list on every call: reload when the tab opens, so a newly copied folder shows up.
$("t-plug").addEventListener("change", load);
$("t-set").addEventListener("change", load); // Agent Tools shows plugin tools: pick up a trust or on/off done in the Plugin tab
document.addEventListener("langchange", render);
load();
