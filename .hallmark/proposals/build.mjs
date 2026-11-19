// Writes a.html, b.html, c.html and index.html: three compositions of the Iris main window from the same parts.
// Run: node build.mjs
import fs from "node:fs";

const opt = (xs, on) => xs.map((x) => `<option${x === on ? " selected" : ""}>${x}</option>`).join("");
const icon = { refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>', mic: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="6" y="1.5" width="4" height="8" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5"/></svg>' };

const session = `<fieldset class="session" data-lock>
  <label>Session Claude Code <select class="sel" id="session"><option value="">Không chọn session</option><option selected>polish-open-iris (đang chạy)</option><option>open-iris (chưa chạy)</option></select></label>
  <button class="btn btn--icon" type="button" id="refresh" aria-label="Tải lại danh sách session" title="Tải lại danh sách session">${icon.refresh}</button>
  <button class="btn" type="button" id="save-session" aria-pressed="true" title="Lưu session này làm mặc định cho lần mở sau">Mặc định</button>
</fieldset>`;

const voice = `<fieldset data-lock>
  <label class="row">Ngôn ngữ <select class="sel" id="lang">${opt(["Tiếng Việt", "English"], "Tiếng Việt")}</select></label>
  <label class="row">Mô hình <select class="sel" id="model">${opt(["gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-3.1-flash-live-preview (legacy)"], "gemini-3.8-live")}</select></label>
  <label class="row">Giọng nói <select class="sel" id="voice">${opt(["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus"], "Kore")}</select></label>
</fieldset>`;

const TOOLS = { task_status: true, task_result: true, task_history: true, do_task: false, task_steer: false, task_stop: false, task_clear: false };
const tools = `<fieldset class="tools" id="tools" data-lock>
  ${Object.entries(TOOLS).map(([n, on]) => `<label class="switch"><input type="checkbox" role="switch" name="${n}"${on ? " checked" : ""}> ${n}</label>`).join("\n  ")}
  <small class="note">Thay đổi có hiệu lực từ lần Bắt đầu kế tiếp.</small>
</fieldset>`;

const PERMS = [["Accessibility", "điều khiển chuột: move, click, scroll", "denied"], ["Camera", "nhận diện tay (HUD)", "granted"], ["Microphone", "voice (Gemini)", "granted"]];
const perms = `<div id="perms">
  <div class="perm-actions">Cấp quyền cho app: <b id="host-app">Orca</b> <button class="btn" type="button" id="host-reveal">Hiện trong Finder</button></div>
  ${PERMS.map(([name, use, state]) => `<div class="perm ${state}"><div><b>${name}</b><small>${use}</small></div><span class="state">${state}</span>${state === "granted" ? "<span></span>" : '<button class="btn" type="button">Mở cài đặt</button>'}</div>`).join("\n  ")}
  <div class="perm-actions"><button class="btn" type="button" id="perm-request">Xin quyền</button> <button class="btn" type="button" id="perm-guide">Hướng dẫn</button> <button class="btn" type="button" id="perm-refresh">Kiểm tra lại</button></div>
</div>`;

const hand = `<div>
  <label class="row">Di chuột <select class="sel" id="mode"><option>Tuyệt đối (tay ở đâu, chuột ở đó)</option><option>Trackpad (đẩy tay, nắm tay = nhấc)</option></select></label>
  <label class="row">Tay điều khiển <select class="sel" id="side"><option>Tay phải</option><option>Tay trái</option></select></label>
  <label class="row">Vùng tay <span class="with"><input id="span" type="range" min="0.2" max="1" step="0.05" value="0.6"> <small>60% khung camera = cả màn hình</small></span></label>
  <label class="row row--check"><input id="camera" type="checkbox"> Hiện camera trên HUD (⌃⌥C)</label>
</div>`;

const log = `<div class="log" id="log" tabindex="0" aria-label="Hội thoại">
  <div class="empty">chưa có hội thoại</div>
  <div class="line you">you: Iris ơi, Claude Code đang làm gì?</div>
  <div class="line">iris: Claude Code vừa trả lời xong, đang chờ bạn giao việc tiếp.</div>
  <div class="line you">you: Đọc lại câu trả lời gần nhất giúp mình.</div>
  <div class="line">iris: Bản tóm tắt: đã sửa xong màn hình chính, còn hai việc đang mở.</div>
</div>`;

const b = {
  toggle: '<button class="btn btn--primary" type="button" id="toggle">Bắt đầu</button>',
  mute: `<button class="btn" type="button" id="mute" disabled>${icon.mic} Mic</button>`,
  status: '<span class="status" id="status" role="status">Chưa chạy</span>',
  folder: '<button class="btn" type="button" id="folder" title="Mở thư mục mẫu hiệu ứng">Mẫu hiệu ứng</button>',
  hud: '<button class="btn" type="button" id="hud" disabled title="Cần quyền Accessibility và Camera">Vào HUD</button>',
};

// The mock only flips offline/listening so both states can be looked at.
const mock = `<script>
const $ = (s) => document.querySelector(s);
$("#toggle").onclick = () => {
  const on = document.body.dataset.state === "offline";
  document.body.dataset.state = on ? "listening" : "offline";
  $("#toggle").textContent = on ? "Dừng" : "Bắt đầu";
  $("#status").textContent = on ? "Đang nghe" : "Chưa chạy";
  $("#mute").disabled = !on;
  document.querySelectorAll("[data-lock]").forEach((f) => (f.disabled = on));
};
</script>`;

const page = (cls, title, body) => `<!doctype html>
<html lang="vi">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Bản đề xuất bố cục cửa sổ chính của Iris: ${title}.">
<title>Iris, ${title}</title>
<link rel="stylesheet" href="app.css">
<body class="app ${cls}" data-state="offline">
${body}
${mock}
`;

const pages = {
  "a.html": ["va", "hội thoại trước", `<header class="bar">
  <h1 class="mark">Iris</h1>
  <fieldset class="tabs"><legend class="visually-hidden">Khu vực</legend>
    <input type="radio" name="tab" id="t-talk" checked><label for="t-talk">Hội thoại</label>
    <input type="radio" name="tab" id="t-set"><label for="t-set">Thiết lập</label>
    <input type="radio" name="tab" id="t-hand"><label for="t-hand">Điều khiển bằng tay</label>
  </fieldset>
</header>
<main>
  <section id="p-talk">${session}\n${log}</section>
  <section id="p-set" class="scroll">${voice}<h2>Công cụ</h2>${tools}</section>
  <section id="p-hand" class="scroll"><h2>Quyền macOS</h2>${perms}<h2>Điều khiển bằng tay</h2>${hand}</section>
</main>
<p class="error" id="error" role="alert" hidden></p>
<footer class="run">${b.toggle} ${b.mute} ${b.status} ${b.folder} ${b.hud}</footer>`],

  "b.html": ["vb", "thiết lập rồi chạy", `<header class="bar"><h1 class="mark">Iris</h1> ${b.status} ${b.toggle}</header>
<p class="error" id="error" role="alert" hidden></p>
<p class="summary">Tiếng Việt, gemini-3.8-live, giọng Kore, session polish-open-iris. Thay đổi có hiệu lực từ lần Bắt đầu kế tiếp.</p>
<main class="setup">
  ${session}${voice}
  <h2>Công cụ</h2>${tools}
  <h2>Điều khiển bằng tay</h2>${hand}
  <h3>Quyền macOS</h3>${perms}
</main>
${log}
<footer class="run">${b.mute} <span class="gap"></span> ${b.folder} ${b.hud}</footer>`],

  "c.html": ["vc", "trạng thái là tiêu đề", `<main class="stage">
  <h1 class="visually-hidden">Iris</h1>
  ${b.status}
  <div class="run">${b.toggle} ${b.mute} <span class="gap"></span> ${b.folder} ${b.hud}</div>
  <p class="error" id="error" role="alert" hidden></p>
  ${session}
</main>
<details class="sheet">
  <summary>Thiết lập <span>Tiếng Việt, gemini-3.8-live, giọng Kore</span></summary>
  ${voice}<h2>Công cụ</h2>${tools}
  <h2>Điều khiển bằng tay</h2>${hand}
  <h3>Quyền macOS</h3>${perms}
</details>
${log}`],
};
for (const [file, [cls, title, body]] of Object.entries(pages)) fs.writeFileSync(new URL(file, import.meta.url), page(cls, title, body));

const NOTES = {
  "a.html": ["A. Hội thoại trước", "Ba thẻ: Hội thoại, Thiết lập, Điều khiển bằng tay. Hội thoại luôn chiếm cả cửa sổ; hàng Bắt đầu nằm yên ở đáy."],
  "b.html": ["B. Thiết lập rồi chạy", "Chưa chạy thì thấy toàn bộ thiết lập trong một danh sách. Bấm Bắt đầu, thiết lập (vốn đã bị khoá) nhường chỗ cho hội thoại."],
  "c.html": ["C. Trạng thái là tiêu đề", "Chữ lớn cho biết Iris đang làm gì, nút Bắt đầu ngay bên dưới. Mọi thiết lập gấp trong một dòng."],
};
fs.writeFileSync(new URL("index.html", import.meta.url), `<!doctype html>
<html lang="vi">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Ba bản đề xuất bố cục cửa sổ chính của Iris, đặt cạnh nhau ở đúng kích thước 520 x 760.">
<title>Iris, ba bản đề xuất</title>
<link rel="stylesheet" href="app.css">
<body>
<main class="container cmp">
  <h1>Ba cách sắp lại cửa sổ Iris</h1>
  <p class="lead">Cùng một hệ màu và chữ trong DESIGN.md, khác bố cục. Bấm Bắt đầu trong từng bản để xem lúc đang chạy; hội thoại là dữ liệu mẫu.</p>
  <div class="board">
${Object.entries(NOTES).map(([f, [name, why]]) => `    <figure><iframe src="${f}" title="${name}"></iframe><figcaption><b>${name}</b>${why} <a href="${f}">Mở riêng</a></figcaption></figure>`).join("\n")}
  </div>
</main>
`);
