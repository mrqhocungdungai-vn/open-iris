// Self-check for desktop.mjs with a fake agent-desktop CLI: node desktop.selftest.mjs (part of pnpm test).
import assert from "node:assert/strict";
import { desktopTools, treeText } from "./desktop.mjs";

// cli(argv, stdin) answers from a list of handlers; every call is recorded.
function fake(answer) {
  const calls = [];
  const cli = async (argv, stdin) => (calls.push({ argv, stdin }), answer(argv) ?? { ok: true, data: {} });
  const tools = Object.fromEntries(desktopTools(cli).map((t) => [t.name, t]));
  return { calls, run: (name, args) => tools[name].run(args) };
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
  const r = await f.run("press_key_combo", { combo: "return", app: "Google Chrome", ref: "@s:e1", confirmed: true });
  assert.equal(r.ok, true);
  assert.match(r.output.verify, /read_app_text/);
  assert.deepEqual(f.calls.map((c) => c.argv), [["--headed", "focus", "@s:e1"], ["--headed", "press", "return", "--app", "Google Chrome"]]);
}
// A focus that fails stops there; no keys go out.
{
  const f = fake((a) => (a[1] === "focus" ? { ok: false, error: { code: "STALE_REF" } } : null));
  assert.equal((await f.run("press_key_combo", { combo: "return", app: "Google Chrome", ref: "@s:e1", confirmed: true })).error.code, "STALE_REF");
  assert.equal(f.calls.length, 1);
}
// Without a ref, headless first; "no focused element" retries headed, other errors go back as they are.
{
  const f = fake((a) => (a[0] === "press" ? { ok: false, error: { code: "ACTION_FAILED" } } : null));
  assert.equal((await f.run("press_key_combo", { combo: "return", app: "Google Chrome", confirmed: true })).ok, true);
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
// read_app_text returns plain text, without repeated lines.
{
  const tree = { name: "Window", children: [{ name: "Hello" }, { value: "Hello" }, { name: " ", children: [{ value: "Bye" }] }] };
  assert.equal(treeText(tree), "Window\nHello\nBye");
  const f = fake(() => ({ ok: true, data: { tree } }));
  assert.equal((await f.run("read_app_text", { app: "Notes" })).output.text, "Window\nHello\nBye");
}
console.log("desktop.selftest ok");
