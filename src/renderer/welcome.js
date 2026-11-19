// Welcome / setup check (index.html #welcome): opens on first launch and from Thiết lập → Kiểm tra cài đặt.
// Steps: welcome, Gemini key, macOS permissions, CLIs, what works now. A missing piece only locks its own feature.
// Uses $ and tr from renderer.js.
(() => {
  const d = $("welcome");
  let step = 0;
  let hasKey = false;
  let perms = {};
  let cli = {};

  // One .perm row (style.css): name, state badge, optional button, what it is for.
  const row = (ok, name, state, why, action) => {
    const r = Object.assign(document.createElement("div"), { className: `perm ${ok ? "granted" : "denied"}` });
    r.append(Object.assign(document.createElement("b"), { textContent: name }), " ", Object.assign(document.createElement("span"), { className: "state", textContent: state }));
    if (action) r.append(" ", Object.assign(document.createElement("button"), { textContent: action[0], onclick: action[1] }));
    r.append(document.createElement("br"), Object.assign(document.createElement("small"), { textContent: why }));
    return r;
  };

  const load = () =>
    Promise.allSettled([window.gesture.getPerms().then((p) => (perms = p || {})), window.iris.checkCoding().then((c) => (cli = c || {}))]).then(() => d.open && render());

  function render() {
    const ok = { mic: perms.microphone === "granted", ax: perms.accessibility === "granted", cam: perms.camera === "granted", orca: !!cli.orca, claude: !!cli.claude };
    const PERMS = [
      ["microphone", "Micro", tr("Để Iris nghe bạn nói", "So Iris can hear you")],
      ["accessibility", "Accessibility", tr("Để Iris bấm, gõ trong app và di chuột bằng tay", "So Iris can click and type in apps, and move the mouse by hand")],
      ["camera", "Camera", tr("Để thấy bàn tay (Hand Task Vision, Gallery)", "To see your hand (Hand Task Vision, Gallery)")],
    ];
    $("w-perms").replaceChildren(...PERMS.map(([kind, name, why]) => {
      const granted = perms[kind] === "granted";
      // Not asked yet: the macOS prompt. Asked and refused: only System Settings can change it.
      const ask = () => (perms[kind] === "not-determined" ? window.gesture.requestPerms().then(load) : window.gesture.openSettings(kind));
      return row(granted, name, granted ? tr("✓ Đã cấp", "✓ Granted") : tr("Chưa cấp", "Not granted"), why, !granted && [tr("Cấp quyền", "Grant"), ask]);
    }));
    const host = perms.host ? perms.host.split("/").pop().replace(/\.app$/, "") : "";
    $("w-perm-note").textContent = tr("Bật xong trong System Settings, quay lại đây: trạng thái tự cập nhật.", "After switching it on in System Settings, come back here: the state updates itself.")
      + (perms.packaged === false && host ? tr(` Bản dev: cấp quyền cho ${host}.`, ` Dev build: grant ${host}.`) : "");

    const recheck = [tr("Kiểm tra lại", "Check again"), load];
    const found = (yes) => (yes ? tr("✓ Tìm thấy", "✓ Found") : tr("Chưa tìm thấy", "Not found"));
    $("w-clis").replaceChildren(
      row(ok.orca, "Orca CLI", found(ok.orca), tr("Mở và điều khiển phiên Claude Code. Cài Orca rồi bấm Kiểm tra lại.", "Opens and drives Claude Code sessions. Install Orca, then Check again."), !ok.orca && recheck),
      row(ok.claude, "Claude Code", found(ok.claude), tr("Agent lập trình mà Iris giao việc.", "The coding agent Iris hands work to."), !ok.claude && recheck),
      row(true, "agent-desktop", tr("✓ Có sẵn", "✓ Bundled"), tr("Đi kèm app, dùng cho tool điều khiển app.", "Comes with the app, used by the app-control tools.")),
    );

    const voice = [[hasKey, "Gemini key"], [ok.mic, "Micro"]];
    const CAPS = [
      [tr("🎙 Nói chuyện với Iris", "🎙 Talk to Iris"), voice],
      [tr("🖱 Điều khiển app bằng giọng", "🖱 Control apps by voice"), [...voice, [ok.ax, "Accessibility"]]],
      ["✋ Hand Task Vision", [[ok.cam, "Camera"], [ok.ax, "Accessibility"]]],
      ["🖼 Gallery View", [[ok.cam, "Camera"]]],
      [tr("🤖 Giao việc cho Claude Code", "🤖 Hand work to Claude Code"), [...voice, [ok.orca, "Orca CLI"], [ok.claude, "Claude Code"]]],
    ];
    const missing = (needs) => needs.filter(([has]) => !has).map(([, name]) => name);
    $("w-caps").replaceChildren(...CAPS.map(([name, needs]) => {
      const lack = missing(needs);
      return row(!lack.length, name, lack.length ? tr("Khoá", "Locked") : tr("✓ Dùng được", "✓ Ready"), lack.length ? tr(`Cần ${lack.join(" + ")}`, `Needs ${lack.join(" + ")}`) : "");
    }));

    const tut = [];
    if (!missing(voice).length) tut.push(tr("Bấm Bắt đầu rồi nói: “mở Notes và viết chữ xin chào”.", "Press Start, then say: “open Notes and write hello”."));
    if (ok.cam && ok.ax) tut.push(tr("Giơ tay trước camera, giữ 🤘 hoặc bấm ⌃⌥G để điều khiển bằng tay. Chụm ngón = click.", "Raise your hand to the camera, hold 🤘 or press ⌃⌥G for hand control. Pinch = click."));
    if (ok.cam) tut.push(tr("Bấm 🖼 Gallery, ✌ để xoay, chụm hai lần để mở.", "Press 🖼 Gallery, ✌ to turn, double-pinch to open."));
    if (!missing(CAPS[4][1]).length) tut.push(tr("Bật Thiết lập → Advanced Tools → Claude Code, chọn session ở tab Hội thoại, rồi nói: “Claude đang làm gì rồi?”.", "Turn on Settings → Advanced Tools → Claude Code, pick a session in the Conversation tab, then say: “What is Claude doing?”."));
    tut.push(tr("⌃⌥H ẩn/hiện HUD. Hướng dẫn đầy đủ ở tab Tính năng.", "⌃⌥H shows/hides the HUD. Full guides are in the Features tab."));
    $("w-tut").replaceChildren(...tut.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  }

  function go(n) {
    step = Math.max(0, Math.min(4, n));
    d.querySelectorAll("section").forEach((s) => (s.hidden = +s.dataset.step !== step));
    d.querySelectorAll(".w-dots i").forEach((dot, i) => dot.classList.toggle("on", i <= step));
    $("w-back").hidden = !step;
    $("w-next").textContent = step === 0 ? tr("Bắt đầu", "Start") : step === 4 ? tr("Vào Iris", "Open Iris") : step === 1 && !hasKey ? tr("Bỏ qua", "Skip") : tr("Tiếp →", "Next →");
    render();
  }

  function open(c) {
    hasKey = !!c.hasKey;
    $("w-key").value = "";
    $("w-key-st").textContent = hasKey ? tr("✓ Đã có key. Nhập key mới để thay.", "✓ A key is set. Enter a new one to replace it.") : "";
    go(0);
    d.showModal();
    load();
  }

  $("w-next").onclick = () => (step === 4 ? d.close() : go(step + 1));
  $("w-back").onclick = () => go(step - 1);
  $("w-key-save").onclick = async () => {
    $("w-key-st").textContent = tr("Đang kiểm tra…", "Checking…");
    const err = await window.iris.saveKey($("w-key").value);
    if (!err) (hasKey = true), ($("w-key").value = "");
    $("w-key-st").textContent = err ? tr(`✕ Key không dùng được (${err})`, `✕ The key does not work (${err})`) : tr("✓ Đã lưu, key hợp lệ", "✓ Saved, the key works");
    go(step);
  };
  d.addEventListener("close", () => window.iris.saveWelcomed()); // closed by Open Iris or Esc: don't show it again on launch
  window.addEventListener("focus", () => d.open && load()); // back from System Settings or a terminal install
  document.addEventListener("langchange", () => d.open && go(step));
  $("welcome-open").onclick = () => window.iris.getConfig().then(open);
  config.then((c) => c.welcomed || open(c));
})();
