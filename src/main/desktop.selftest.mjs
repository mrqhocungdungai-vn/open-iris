// Self-check for desktop.mjs with a fake agent-desktop CLI: node desktop.selftest.mjs (part of pnpm test).
import assert from "node:assert/strict";
import { cleanTools, desktopTools, DESKTOP_BRIEF, TOOL_DEFAULTS, treeText } from "./desktop.mjs";

// cli(argv, stdin) answers from a list of handlers; every call is recorded.
function fake(answer) {
  const calls = [];
  const cli = async (argv, stdin) => (calls.push({ argv, stdin }), answer(argv) ?? { ok: true, data: {} });
  const tools = Object.fromEntries(desktopTools(cli).map((t) => [t.name, t]));
  const run = (name, args) => tools[name].run(args);
  // A confirmed call as Gemini must make it: refused first, then sent again with the user's yes.
  const runYes = async (name, args) => (assert.equal((await run(name, args)).error.code, "NEEDS_CONFIRMATION"), run(name, { ...args, confirmed: true }));
  return { calls, run, runYes };
}

// cleanTools: unknown and old coding keys are dropped, missing ones get defaults, values become booleans.
{
  const t = cleanTools({ start_coding_task: true, do_task: true, bogus: 1, click_app_control: 0, read_app_text: "yes" });
  assert.deepEqual(Object.keys(t), Object.keys(TOOL_DEFAULTS));
  assert.equal(t.click_app_control, false);
  assert.equal(t.read_app_text, true);
  assert.equal(t.press_key_combo, TOOL_DEFAULTS.press_key_combo);
  assert.deepEqual(cleanTools(), TOOL_DEFAULTS);
  // The switches cover exactly the desktop tools.
  assert.deepEqual(Object.keys(TOOL_DEFAULTS).sort(), desktopTools().map((x) => x.name).sort());
}

// Every tool is marked desktop and has a schema Gemini accepts.
for (const t of desktopTools()) assert.ok(t.desktop && t.parameters.type === "object", t.name);

// A Send button needs the user's yes; with confirmed it clicks.
{
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: "Gửi tin nhắn" } : null));
  const r = await f.run("click_app_control", { ref: "@s:e1" });
  assert.equal(r.error.code, "NEEDS_CONFIRMATION");
  assert.deepEqual(f.calls.map((c) => c.argv[0]), ["get"]);
  assert.equal((await f.run("click_app_control", { ref: "@s:e1", confirmed: true })).ok, true);
  assert.deepEqual(f.calls.at(-1).argv, ["click", "@s:e1"]);
  // The yes covers one click: the next Send asks again.
  assert.equal((await f.run("click_app_control", { ref: "@s:e1", confirmed: true })).error.code, "NEEDS_CONFIRMATION");
}
// confirmed true sent before anyone was asked does not pass (Gemini set it on its own, log 2026-11-20).
{
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: "Send" } : null));
  assert.equal((await f.run("click_app_control", { ref: "@s:e1", confirmed: true })).error.code, "NEEDS_CONFIRMATION");
  assert.ok(!f.calls.some((c) => c.argv[0] === "click"));
  // A yes for another ref does not carry over.
  assert.equal((await f.run("click_app_control", { ref: "@s:e2", confirmed: true })).error.code, "NEEDS_CONFIRMATION");
  const g = fake(() => null);
  assert.equal((await g.run("press_key_combo", { combo: "return", app: "Telegram", confirmed: true })).error.code, "NEEDS_CONFIRMATION");
  assert.equal(g.calls.length, 0);
  // A harmless button with confirmed true still clicks.
  const h = fake((a) => (a[0] === "get" ? { ok: true, data: "Done" } : null));
  assert.equal((await h.run("click_app_control", { ref: "@s:e5", confirmed: true })).ok, true);
}
// A harmless button clicks at once.
{
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: "Bold" } : null));
  assert.equal((await f.run("click_app_control", { ref: "@s:e2" })).ok, true);
}
// Return needs a yes, other combos do not.
{
  const f = fake(() => null);
  assert.equal((await f.run("press_key_combo", { combo: "cmd+return", app: "Notes" })).error.code, "NEEDS_CONFIRMATION");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run("press_key_combo", { combo: "cmd+n", app: "Notes" })).ok, true);
}
// Chrome: typed with physical keystrokes from the start, so its address bar acts on return.
{
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: "" } : null));
  assert.equal((await f.run("type_into_text_field", { ref: "@s:e1", text: "tesla", app: "Google Chrome", replace: true })).output.fallback, "type --headed");
  assert.deepEqual(f.calls.at(-1).argv, ["--headed", "type", "@s:e1", "--stdin"]);
}
// Return with the field's ref: focus it, then press physically (Chrome ignored a headless return, log 2026-11-19).
{
  const f = fake(() => null);
  const r = await f.runYes("press_key_combo", { combo: "return", app: "Google Chrome", ref: "@s:e1" });
  assert.equal(r.ok, true);
  assert.match(r.output.verify, /read_app_text/);
  assert.deepEqual(f.calls.map((c) => c.argv), [["find", "--root", "@s:e1"], ["--headed", "focus", "@s:e1"], ["--headed", "press", "return", "--app", "Google Chrome"]]);
}
// Return in an address or search box goes at once; a chat box still needs a yes (log 2026-11-20).
{
  const box = (name, role = "textfield") => fake((a) => (a[0] === "find" ? { ok: true, data: { matches: [{ name, role }] } } : null));
  for (const [name, role] of [["Address and search bar"], ["Tìm kiếm"], ["", "searchfield"]]) {
    const f = box(name, role);
    assert.equal((await f.run("press_key_combo", { combo: "return", app: "Google Chrome", ref: "@s:e1" })).ok, true);
    assert.deepEqual(f.calls.at(-1).argv, ["--headed", "press", "return", "--app", "Google Chrome"]);
  }
  const chat = box("Write a message…", "textarea");
  assert.equal((await chat.run("press_key_combo", { combo: "return", app: "Telegram", ref: "@s:e2" })).error.code, "NEEDS_CONFIRMATION");
  assert.ok(!chat.calls.some((c) => c.argv.includes("press")));
}
// A focus that fails stops there; no keys go out.
{
  const f = fake((a) => (a[1] === "focus" ? { ok: false, error: { code: "STALE_REF" } } : null));
  assert.equal((await f.runYes("press_key_combo", { combo: "return", app: "Google Chrome", ref: "@s:e1" })).error.code, "STALE_REF");
  assert.equal(f.calls.filter((c) => c.argv[1] === "focus").length, 1);
  assert.ok(!f.calls.some((c) => c.argv.includes("press")));
}
// Without a ref, headless first; "no focused element" retries headed, other errors go back as they are.
{
  const f = fake((a) => (a[0] === "press" ? { ok: false, error: { code: "ACTION_FAILED" } } : null));
  assert.equal((await f.runYes("press_key_combo", { combo: "return", app: "Google Chrome" })).ok, true);
  assert.deepEqual(f.calls.map((c) => c.argv[0]), ["press", "--headed"]);
  const g = fake((a) => (a[0] === "press" ? { ok: false, error: { code: "APP_NOT_FOUND" } } : null));
  assert.equal((await g.run("press_key_combo", { combo: "cmd+n", app: "Nope" })).error.code, "APP_NOT_FOUND");
  assert.equal(g.calls.length, 1);
}
// The same call a fourth time in a row is refused; a different call resets the count.
{
  const f = fake(() => null);
  for (let i = 0; i < 3; i++) assert.equal((await f.run("list_running_apps", {})).ok, true);
  assert.equal((await f.run("list_running_apps", {})).error.code, "LOOP");
  await f.run("open_or_focus_app", { app: "Notes" });
  assert.equal((await f.run("list_running_apps", {})).ok, true);
}
// A field that ignores semantic type falls back to set-value, and the next type in that app starts there. Text goes via stdin.
{
  const ignored = { ok: false, error: { details: { kind: "post_action_verification" } } };
  const f = fake((a) => (a[0] === "type" ? ignored : null));
  const r = await f.run("type_into_text_field", { ref: "@s:e3", text: "xin chào", app: "Teams" });
  assert.equal(r.output.fallback, "set-value");
  assert.ok(f.calls.every((c) => !c.argv.includes("xin chào")) && f.calls.at(-1).stdin === "xin chào");
  const before = f.calls.length;
  await f.run("type_into_text_field", { ref: "@s:e3", text: "nữa", app: "Teams" });
  assert.deepEqual(f.calls.slice(before).map((c) => c.argv[0]), ["set-value"]);
}
// A field with only SetValue (Telegram Lite) gets set-value, and nothing types after it, so the text is not doubled.
{
  const f = fake((a) => (a[0] === "type" ? { ok: false, error: { code: "POLICY_DENIED" } } : null));
  assert.equal((await f.run("type_into_text_field", { ref: "@s:e6", text: "Hello", app: "Telegram Lite" })).output.fallback, "set-value");
  assert.deepEqual(f.calls.map((c) => c.argv[0]), ["type", "set-value"]);
}
// A stale ref goes straight back to the model, no other way is tried.
{
  const f = fake((a) => (a[0] === "type" ? { ok: false, error: { code: "STALE_REF" } } : null));
  assert.equal((await f.run("type_into_text_field", { ref: "@s:e4", text: "a", app: "Notes" })).error.code, "STALE_REF");
  assert.equal(f.calls.length, 1);
}
// replace clears the field first.
{
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: "" } : null));
  await f.run("type_into_text_field", { ref: "@s:e5", text: "a", app: "Safari", replace: true });
  assert.deepEqual(f.calls.map((c) => c.argv[0]), ["clear", "get", "type"]);
}
// A field that ignores clear (Teams) is cleared with ⌘A, delete before typing.
{
  let value = "OKEM";
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: value } : a[1] === "delete" ? ((value = ""), null) : null));
  await f.run("type_into_text_field", { ref: "@s:e5", text: "okay", app: "Microsoft Teams", replace: true });
  assert.deepEqual(f.calls.map((c) => c.argv.slice(0, 2).join(" ")), ["clear @s:e5", "get @s:e5", "--headed focus", "press cmd+a", "press delete", "type @s:e5"]);
}
// Teams reports its placeholder as the value, so no read-back fails the call: it types and asks the model to check.
{
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: { value: "Type a message\n" } } : null));
  const r = await f.run("type_into_text_field", { ref: "@s:e5", text: "okay", app: "Microsoft Teams", replace: true });
  assert.ok(r.ok);
  assert.match(r.output.verify, /read_app_text/);
  assert.equal(f.calls.filter((c) => c.argv[0] === "get").length, 1);
}
// An unverified delivery tells the model to check before claiming success.
{
  const f = fake(() => ({ ok: true, data: { disposition: { delivery: "delivered_unverified" } } }));
  assert.match((await f.run("press_key_combo", { combo: "cmd+f", app: "Safari" })).output.verify, /read_app_text/);
}
// close_app always asks first, never forces, and passes on the surfaces an action reports.
{
  const f = fake(() => ({ ok: true, data: { surfaces: [{ id: "focused-window", type: "sheet" }] } }));
  assert.equal((await f.run("close_app", { app: "Spotify", confirmed: true })).error.code, "NEEDS_CONFIRMATION");
  assert.equal(f.calls.length, 0);
  const r = await f.run("close_app", { app: "Spotify", confirmed: true });
  assert.deepEqual(f.calls.map((c) => c.argv), [["close-app", "Spotify"]]);
  assert.equal(r.output.data.surfaces[0].type, "sheet");
  // The yes covers one quit.
  assert.equal((await f.run("close_app", { app: "Spotify", confirmed: true })).error.code, "NEEDS_CONFIRMATION");
}
// open-iris itself and terminals are never closed, not even after a yes.
for (const app of ["open-iris", "Electron", "Terminal", "iTerm2", "Warp", " ghostty "]) {
  const f = fake(() => null);
  assert.equal((await f.run("close_app", { app })).error.code, "NOT_ALLOWED", app);
  assert.equal((await f.run("close_app", { app, confirmed: true })).error.code, "NOT_ALLOWED", app);
  assert.equal(f.calls.length, 0);
}
// Bundle ids name an app too (list-windows --app com.apple.finder resolves), and list_running_apps shows them to Gemini.
for (const app of ["com.apple.Terminal", "com.googlecode.iterm2", "com.github.Electron", "com.open-iris.app", "dev.warp.Warp-Stable", "com.mitchellh.ghostty"]) {
  const f = fake(() => null);
  assert.equal((await f.run("close_app", { app })).error.code, "NOT_ALLOWED", app);
  assert.equal((await f.run("close_app", { app, confirmed: true })).error.code, "NOT_ALLOWED", app);
  assert.equal(f.calls.length, 0);
}
assert.equal((await fake(() => null).run("close_app", { app: "com.spotify.client" })).error.code, "NEEDS_CONFIRMATION");
// The menubar's Quit item is a second way to quit: the same apps are refused there, even after a yes.
for (const label of ["Quit Terminal", "Quit open-iris", "Quit Electron", "Quit iTerm2"]) {
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: label } : null));
  assert.equal((await f.run("click_app_control", { ref: "@m:e9" })).error.code, "NOT_ALLOWED", label);
  assert.equal((await f.run("click_app_control", { ref: "@m:e9", confirmed: true })).error.code, "NOT_ALLOWED", label);
  assert.ok(!f.calls.some((c) => c.argv[0] === "click"), label);
}
assert.equal((await fake((a) => (a[0] === "get" ? { ok: true, data: "Quit TextEdit" } : null)).runYes("click_app_control", { ref: "@m:e9" })).ok, true);
// cmd+d and cmd+delete pick Don't Save in a macOS save alert, so they ask like return.
for (const combo of ["cmd+d", "Cmd+D", "cmd+delete", "cmd+backspace", "command+d"]) {
  const f = fake(() => null);
  assert.equal((await f.run("press_key_combo", { combo, app: "TextEdit" })).error.code, "NEEDS_CONFIRMATION", combo);
  assert.equal(f.calls.length, 0, combo);
  assert.equal((await f.run("press_key_combo", { combo, app: "TextEdit", confirmed: true })).ok, true, combo);
}
// Unsaved docs: close-app times out with an alert open, and the tool says so with the surfaces (TextEdit probe, 2026-11-21).
{
  const f = fake((a) => (a[0] === "close-app" ? { ok: false, error: { code: "TIMEOUT" } } : a[0] === "list-surfaces" ? { ok: true, data: { surfaces: [{ id: "focused-window", title: "", type: "alert" }] } } : null));
  const r = await f.runYes("close_app", { app: "TextEdit" });
  assert.equal(r.error.code, "DIALOG_OPEN");
  assert.equal(r.error.surfaces[0].type, "alert");
  assert.deepEqual(f.calls.map((c) => c.argv), [["close-app", "TextEdit"], ["list-surfaces", "--app", "TextEdit"]]);
  assert.ok(!f.calls.some((c) => c.argv.includes("--force")));
  // A timeout with no dialog goes back as it is.
  const g = fake((a) => (a[0] === "close-app" ? { ok: false, error: { code: "TIMEOUT" } } : null));
  assert.equal((await g.runYes("close_app", { app: "TextEdit" })).error.code, "TIMEOUT");
}
// scroll_app_view: headless only, amount defaults to 3 and is clamped to 1..20, unknown directions never reach the CLI.
{
  const f = fake(() => null);
  for (const [amount, n] of [[undefined, "3"], [0.4, "1"], [99, "20"], ["7", "7"]]) {
    assert.equal((await f.run("scroll_app_view", { app: "Safari", ref: "@s:e1", direction: "down", amount })).ok, true);
    assert.deepEqual(f.calls.at(-1).argv, ["scroll", "@s:e1", "--direction", "down", "--amount", n]);
  }
  assert.ok(!f.calls.some((c) => c.argv.includes("--headed")));
  const before = f.calls.length;
  assert.equal((await f.run("scroll_app_view", { app: "Safari", ref: "@s:e1", direction: "sideways" })).error.code, "INVALID_ARGS");
  assert.match((await f.run("scroll_app_view", { app: "Safari", ref: "", direction: "down" })).error.message, /scan_app_controls/);
  assert.equal(f.calls.length, before);
}
// A scroll that was not delivered and is safe to retry is tried once more; an unsafe one goes back as it is.
{
  const err = (retry) => ({ ok: false, error: { code: "ACTION_FAILED", disposition: { delivery: "not_delivered", retry } } });
  let n = 0;
  const f = fake(() => (n++ ? null : err("safe")));
  assert.equal((await f.run("scroll_app_view", { app: "Safari", ref: "@s:e1", direction: "up" })).ok, true);
  assert.equal(f.calls.length, 2);
  const g = fake(() => err("safe"));
  assert.equal((await g.run("scroll_app_view", { app: "Safari", ref: "@s:e1", direction: "up" })).error.code, "ACTION_FAILED");
  assert.equal(g.calls.length, 2);
  const h = fake(() => err("unsafe"));
  await h.run("scroll_app_view", { app: "Safari", ref: "@s:e1", direction: "up" });
  assert.equal(h.calls.length, 1);
}
// Switched off, scroll_app_view is not offered (main.mjs offers only tools whose switch is on).
assert.equal(cleanTools({ scroll_app_view: false }).scroll_app_view, false);
assert.match(DESKTOP_BRIEF, /scroll_app_view/);
// The cmd+q hint points to close_app, not to a close button.
assert.match(desktopTools().find((t) => t.name === "press_key_combo").description, /close_app/);
// surface: argv per tool, never with --root or --skeleton; surface+root and unknown surfaces never reach the CLI.
{
  const f = fake(() => null);
  await f.run("scan_app_controls", { app: "TextEdit", surface: "sheet" });
  assert.deepEqual(f.calls.at(-1).argv, ["snapshot", "--app", "TextEdit", "-i", "--compact", "--surface", "sheet"]);
  await f.run("find_app_control", { app: "TextEdit", surface: "focused", role: "button", text: "Cancel" });
  assert.deepEqual(f.calls.at(-1).argv, ["find", "--app", "TextEdit", "--surface", "focused", "--role", "button", "--text", "Cancel"]);
  await f.run("read_app_text", { app: "TextEdit", surface: "focused" });
  assert.deepEqual(f.calls.at(-1).argv, ["snapshot", "--app", "TextEdit", "--compact", "--max-depth", "50", "--surface", "focused"]);
  const before = f.calls.length;
  assert.match((await f.run("scan_app_controls", { app: "TextEdit", surface: "sheet", root: "@s:e1" })).error.message, /not both/);
  // System-wide surfaces (notification-center ...) would read outside the named app.
  assert.equal((await f.run("read_app_text", { app: "TextEdit", surface: "notification-center" })).error.code, "INVALID_ARGS");
  assert.equal(f.calls.length, before);
}
// find in the menubar filters a snapshot, since find --surface menubar times out (TextEdit probe, 2026-11-21).
{
  const tree = { role: "menu", children: [{ role: "menuitem", name: "File", ref_id: "@m:e1", children: [
    { role: "menuitem", name: "New", ref_id: "@m:e2" }, { role: "menuitem", name: "Save…", ref_id: "@m:e3", states: ["disabled"] }] }] };
  const f = fake((a) => (a[0] === "snapshot" ? { ok: true, data: { tree } } : null));
  const r = await f.run("find_app_control", { app: "TextEdit", surface: "menubar", text: "save" });
  assert.deepEqual(f.calls.map((c) => c.argv), [["snapshot", "--app", "TextEdit", "-i", "--compact", "--surface", "menubar"]]);
  assert.deepEqual(r.output.data.matches, [{ ref_id: "@m:e3", role: "menuitem", name: "Save…", states: ["disabled"] }]);
  assert.equal((await f.run("find_app_control", { app: "TextEdit", surface: "menubar", role: "menuitem" })).output.data.total_matches, 3);
}
// A click that opened an overlay lists it on top; pick_list_option too.
{
  const sheet = [{ id: "focused-window", title: "save", type: "sheet" }];
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: "Save" } : { ok: true, data: { surfaces: sheet } }));
  assert.deepEqual((await f.run("click_app_control", { ref: "@m:e3" })).output.surfaces, sheet);
  assert.deepEqual((await f.run("pick_list_option", { ref: "@s:e4", value: "PDF" })).output.surfaces, sheet);
  const g = fake(() => ({ ok: true, data: { surfaces: [] } }));
  assert.equal((await g.run("pick_list_option", { ref: "@s:e4", value: "PDF" })).output.surfaces, undefined);
}
// Buttons in a sheet or alert that lose work still ask first; get's text is the AX label (TextEdit probe).
for (const label of ["Delete", "Don't Save", "Don’t Save", "Save and Quit", "Discard"]) {
  const f = fake((a) => (a[0] === "get" ? { ok: true, data: { property: "text", ref: "@a:e2", value: label } } : null));
  assert.equal((await f.run("click_app_control", { ref: "@a:e2" })).error.code, "NEEDS_CONFIRMATION", label);
  assert.ok(!f.calls.some((c) => c.argv[0] === "click"), label);
}
// Two windows: AMBIGUOUS_TARGET comes back as windows [{id, title}] only, and the second turn passes window_id (TextEdit probe, 2026-11-21).
{
  const candidates = [{ id: "w-5993", is_focused: false, title: "Untitled", visible: true }, { id: "w-5997", is_focused: false, title: "Gmail", visible: true }];
  const f = fake((a) => (a.includes("--window-id") ? null : { ok: false, error: { code: "AMBIGUOUS_TARGET", message: "More than one window", suggestion: "Run 'list-windows'", details: { candidate_count: 2, candidates } } }));
  for (const [name, argv] of [
    ["read_app_text", ["snapshot", "--app", "Chrome", "--window-id", "w-5997", "--compact", "--max-depth", "50"]],
    ["scan_app_controls", ["snapshot", "--app", "Chrome", "--window-id", "w-5997", "-i", "--compact", "--skeleton"]],
    ["find_app_control", ["find", "--app", "Chrome", "--window-id", "w-5997", "--role", "button"]],
  ]) {
    const r = await f.run(name, { app: "Chrome", role: name === "find_app_control" ? "button" : undefined });
    assert.deepEqual(r.error, { code: "AMBIGUOUS_TARGET", windows: [{ id: "w-5993", title: "Untitled" }, { id: "w-5997", title: "Gmail" }] }, name);
    const id = r.error.windows.find((w) => w.title === "Gmail").id;
    assert.equal((await f.run(name, { app: "Chrome", window_id: id, role: name === "find_app_control" ? "button" : undefined })).ok, true, name);
    assert.deepEqual(f.calls.at(-1).argv, argv, name);
  }
  assert.match(DESKTOP_BRIEF, /window_id/);
}
// read_app_text returns plain text, without repeated lines.
{
  const tree = { name: "Window", children: [{ name: "Hello" }, { value: "Hello" }, { name: " ", children: [{ value: "Bye" }] }] };
  assert.equal(treeText(tree), "Window\nHello\nBye");
  const f = fake(() => ({ ok: true, data: { tree } }));
  assert.equal((await f.run("read_app_text", { app: "Notes" })).output.text, "Window\nHello\nBye");
}
// find with no match in the window looks in the focused alert next: Gemini left surface out 3/3 (eval case 15, 2026-11-21).
{
  const f = fake((a) => (a[0] === "find" ? { ok: true, data: { matches: a.includes("focused") ? [{ ref: "@b:e2", name: "Delete" }] : [] } } : null));
  const r = await f.run("find_app_control", { app: "TextEdit", text: "Delete", role: "button" });
  assert.equal(r.output.data.matches[0].ref, "@b:e2");
  assert.deepEqual(f.calls.at(-1).argv, ["find", "--app", "TextEdit", "--surface", "focused", "--role", "button", "--text", "Delete"]);
  const g = fake((a) => (a.includes("focused") ? { ok: false, error: { code: "ELEMENT_NOT_FOUND" } } : { ok: true, data: { matches: [] } }));
  assert.deepEqual((await g.run("find_app_control", { app: "TextEdit", text: "x" })).output.data.matches, []);
}
console.log("desktop.selftest ok");
