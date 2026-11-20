// Features › Hand Task Vision: its on/off switch (the engine is gesture/engine.js) + "⚙ Quyền macOS" precheck panel.
// The HUD switch (footer) is separate: the overlay only displays, it works with or without the feature.
{
  const $ = (id) => document.getElementById(id);
  // tr() comes from renderer.js (UI language); the permission names stay English, as in System Settings.
  const PERMS = {
    accessibility: ["Accessibility", () => tr("điều khiển chuột: move, click, scroll", "mouse control: move, click, scroll")],
    camera: ["Camera", () => tr("nhận diện tay (Hand Task Vision)", "hand tracking (Hand Task Vision)")],
    microphone: ["Microphone", () => "voice (Gemini)"],
  };
  let vision = false;
  let ready = false;
  let autoStarted = false; // on by default: started once, when the permissions are first seen granted; control still needs 🤘 or ⌃⌥G
  const loaded = new Promise((r) => addEventListener("load", r, { once: true })); // engine.js (a module) listens for "vision" only by then
  let host = "";
  let packaged = false;
  // Dev (pnpm dev): macOS grants the terminal app; built app: open-iris itself.
  const hostName = () => host || (packaged ? "open-iris" : tr("app chạy pnpm dev", "the app running pnpm dev"));
  const relaunch = () => (packaged ? tr("mở lại open-iris", "open open-iris again") : tr("chạy lại pnpm dev", "run pnpm dev again"));
  let perms = null; // last state, re-rendered on a language switch
  let hint = null; // () => text of #perm-hint, same reason
  const showHint = (fn) => ((hint = fn), ($("perm-hint").textContent = fn()));

  const showVision = () => {
    $("vision").checked = vision;
    $("vision").disabled = !vision && !ready;
    $("vision").parentElement.title = $("vision").disabled ? tr("Cần quyền Accessibility và Camera: xem Quyền macOS bên dưới", "Needs Accessibility and Camera permission: see macOS permissions below") : "";
  };

  const showPerms = (p) => {
    if (!p) return;
    perms = p;
    packaged = !!p.packaged;
    host = p.host ? p.host.split("/").pop().replace(/\.app$/, "") : "Electron";
    $("host-app").textContent = hostName();
    $("host-reveal").hidden = !p.host;
    document.querySelectorAll("#perms .perm").forEach((row) => row.remove());
    for (const [kind, [label, usedFor]] of Object.entries(PERMS)) {
      const state = p[kind] || "unknown";
      const row = Object.assign(document.createElement("div"), { className: `perm ${state}` });
      const open = Object.assign(document.createElement("button"), { textContent: tr("Mở cài đặt", "Open Settings"), hidden: state === "granted" });
      open.onclick = () => window.gesture.openSettings(kind);
      const name = Object.assign(document.createElement("b"), { textContent: label, lang: "en" });
      const badge = Object.assign(document.createElement("span"), { className: "state", textContent: state });
      const note = Object.assign(document.createElement("small"), { textContent: usedFor() });
      row.append(name, " ", badge, " ", open, document.createElement("br"), note);
      $("perms").insertBefore(row, $("perms").lastElementChild);
    }
    ready = p.accessibility === "granted" && p.camera === "granted";
    if (ready && !autoStarted) (autoStarted = true), loaded.then(() => window.gesture.vision(true));
    showVision();
  };

  const refresh = () =>
    window.gesture.getPerms().then(showPerms, (e) => {
      $("t-feat").checked = true; // the hint below is on the Features tab
      $("perm-hint").hidden = false;
      showHint(() => tr(`Không đọc được trạng thái quyền (${e.message}). Thoát rồi ${relaunch()}.`, `Could not read the permission state (${e.message}). Quit and ${relaunch()}.`));
    });

  window.gesture.onPerms(showPerms);
  window.gesture.onVision((on) => { vision = on; showVision(); });
  window.gesture.onHud((on) => ($("hud").checked = on));
  window.gesture.vision(false); // page (re)load: the engine here starts stopped, so main's state must match
  $("perm-request").onclick = async () => showPerms(await window.gesture.requestPerms());
  $("perm-refresh").onclick = refresh;
  $("host-reveal").onclick = () => window.gesture.revealHost();
  $("perm-guide").onclick = () => {
    $("perm-hint").hidden = !$("perm-hint").hidden;
    showHint(() => tr(
      (packaged ? "" : `Khi chạy pnpm dev, macOS cấp quyền cho app mở terminal (${hostName()}), không phải cho Electron. `) +
        `System Settings › Privacy & Security › từng mục bên trên › bật ${hostName()}. ` +
        `Accessibility: nếu đã bật mà vẫn denied thì tắt/bật lại, rồi thoát hẳn ${hostName()} và ${relaunch()}.`,
      (packaged ? "" : `With pnpm dev, macOS grants permissions to the app that opened the terminal (${hostName()}), not to Electron. `) +
        `System Settings › Privacy & Security › each item above › turn on ${hostName()}. ` +
        `Accessibility: if it is on but still denied, turn it off and on, then quit ${hostName()} completely and ${relaunch()}.`,
    ));
  };
  $("vision").onchange = () => window.gesture.vision($("vision").checked); // main echoes "vision" back, which settles the switch
  $("hud").onchange = () => window.gesture.hud($("hud").checked); // same for "hud"

  // Features › Gallery View: the switch only enables it, showing 🖼 Gallery in the footer; that button opens your home folder ~/
  // full screen in the overlay. Switching off also closes an open gallery.
  $("gallery-on").onchange = () => {
    $("gallery-open").hidden = !$("gallery-on").checked;
    window.iris.galleryEnabled($("gallery-on").checked); // the HUD shows its 🖼 only while enabled
    if (!$("gallery-on").checked) window.iris.closeGallery();
  };
  window.iris.galleryEnabled($("gallery-on").checked); // page (re)load: the switch starts on, so main's state must match
  $("gallery-open").onclick = async () => {
    const why = await window.iris.openGallery().catch((e) => e.message); // an unreadable folder throws
    if (why) $("error").textContent = tr("Không mở được gallery: ", "Could not open the gallery: ") + why, ($("error").hidden = false);
  };
  // While enabled, a folder dragged from Finder onto the window opens it too. Without preventDefault Electron would navigate to the file.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = $("gallery-on").checked && e.dataTransfer.files[0];
    const why = file && (await window.iris.openGallery(file).catch((e) => e.message));
    if (why) $("error").textContent = tr("Không mở được gallery: ", "Could not open the gallery: ") + why, ($("error").hidden = false);
  });
  // ▾ on the preview: collapse it to one line (only the recognised pose), ▴ opens it again. This window only; the HUD has its own 📷.
  $("hv-hide").onclick = () => {
    const mini = $("hv-view").classList.toggle("mini");
    $("hv-hide").setAttribute("aria-pressed", mini);
    $("hv-hide").textContent = mini ? "▴" : "▾";
  };
  // ⧉: same toggle as the HUD 📷, the "Iris Camera" window (hud.mjs openPop).
  $("hv-pop").onclick = () => window.gesture.popout();
  window.gesture.onPopout((on) => $("hv-pop").setAttribute("aria-pressed", on));
  const showSettings = ({ span, mode, side }) => {
    $("mode").value = mode;
    $("side").value = side;
    $("span").value = span;
    $("span-row").hidden = mode === "trackpad"; // trackpad ignores the hand area
    $("span-text").textContent = `${Math.round(span * 100)}% ` + tr("khung camera = cả màn hình (nhỏ → quơ tay ít hơn, nhưng run hơn)", "of the camera frame = the whole screen (smaller → less arm movement, but more jitter)");
  };
  document.addEventListener("langchange", () => {
    showPerms(perms);
    showVision();
    if (hint) $("perm-hint").textContent = hint();
    showSettings({ span: +$("span").value, mode: $("mode").value, side: $("side").value });
  });
  const save = () => {
    const s = { span: +$("span").value, mode: $("mode").value, side: $("side").value };
    showSettings(s);
    window.gesture.setSettings(s); // camera left out: main keeps the HUD's own choice
  };
  $("span").oninput = save;
  $("mode").onchange = save;
  $("side").onchange = save;
  window.gesture.onSettings(showSettings);
  window.gesture.getSettings().then(showSettings);
  window.addEventListener("focus", refresh);
  refresh();
}
