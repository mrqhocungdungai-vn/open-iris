// node examples.selftest.mjs: the example plugins in examples/plugins/ against the core contract (plan K2, K4).
// If the core changes how it loads or runs a plugin, these go red before a real plugin breaks.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHooks, loadPlugin, previewPlugin, sampleValues, trustHash } from "./hooks.mjs";
import { liveSetup, pluginNotes } from "./live-config.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ex = (name) => loadPlugin(path.join(repo, "examples/plugins", name));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-examples-"));
const allOn = (p) => ({ [p.name]: { on: true, fields: sampleValues(p), groups: Object.fromEntries(p.groups.map((g) => [g.name, { on: true }])), tools: Object.fromEntries(p.tools.map((t) => [t.name, { on: true }])) } });
function clock() {
  let t = 0, fn = null;
  return {
    now: () => t, setInterval: (f) => ((fn = f), { unref() {} }), clearInterval: () => (fn = null),
    async run(sec) { for (let i = 0; i < sec; i++) { t += 1000; fn?.(); await new Promise((r) => setImmediate(r)); } },
  };
}
// The session a user gets with this plugin on and trusted as it is on disk.
const session = (p, more = {}) => createHooks({ plugins: [p], getConfig: () => allOn(p), trust: { [p.name]: trustHash(p.dir) }, home, appPath: "/usr/bin:/bin", send: () => true, ...more });

// speak-tick: every 2 min, after 4 s of quiet, Iris gets one SYSTEM_EVENT_HOOK turn with the field filled.
{
  const p = ex("speak-tick"), c = clock(), sent = [];
  const h = session(p, { send: (t) => sent.push([c.now(), t]), now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval });
  assert.equal((await h.emit("SessionStart")).context, "");
  assert.equal(h.speaks(), true);
  h.start();
  await c.run(119);
  assert.equal(sent.length, 0);
  await c.run(2);
  // due at 120 s; the group runs then and the next 1 s loop sends it
  assert.deepEqual(sent, [[121_000, "SYSTEM_EVENT_HOOK speak-tick/remind: Remind the user to stretch."]]);
  assert.deepEqual((await previewPlugin(p, sampleValues(p), home)).speak, [sent[0][1]]); // the preview shows what is really sent
  h.stop();
}

// context-start: SessionStart context goes last in the plugin-notes block; nothing speaks.
{
  const p = ex("context-start"), h = session(p);
  const { context } = await h.emit("SessionStart");
  assert.equal(context, "The user works on the design team.");
  assert.equal(h.speaks(), false);
  assert.ok(liveSetup("en", [], "", { plugin: context }).systemInstruction.parts[0].text.endsWith(pluginNotes(context)));
  assert.equal((await previewPlugin(p, sampleValues(p), home)).context, context);
}

// block-tool: its command (real /bin/sh) blocks press_key_combo with its stderr as the reason, and only that tool.
{
  const p = ex("block-tool"), h = session(p);
  await h.emit("SessionStart");
  assert.deepEqual(await h.emit("PreToolCall", { tool: { name: "press_key_combo", args: {} } }),
    { block: true, reason: "key combos are off in this example", by: "block-tool/no-keys", context: "", tainted: true });
  assert.equal((await h.emit("PreToolCall", { tool: { name: "click_app_control", args: {} } })).block, false);
  // Not trusted (folder changed or never approved): fail closed.
  const untrusted = session(p, { trust: {} });
  assert.match((await untrusted.emit("PreToolCall", { tool: { name: "press_key_combo", args: {} } })).reason, /not trusted/);
}

// late-tool: a NON_BLOCKING declaration; the first line answers at once, the second comes through onLate.
{
  const p = ex("late-tool"), h = session(p);
  await h.emit("SessionStart");
  assert.equal(h.speaks(), true);
  const [t] = h.tools();
  assert.equal(t.name, "late-tool__count_down");
  assert.equal(liveSetup("en", h.tools()).tools[0].functionDeclarations[0].behavior, "NON_BLOCKING");
  let late;
  const done = new Promise((r) => (late = r));
  assert.deepEqual(await t.run({ seconds: 1 }, { id: "c1", onLate: (o) => late(o) }),
    { ok: true, output: { plugin_output: "countdown started", from: "late-tool" }, late: true });
  assert.deepEqual(await done, { ok: true, output: "countdown done" });
  assert.deepEqual(await t.run({}, { id: "c2" }), { ok: false, error: "missing argument seconds" });
}

// pnpm plugin:check: every example passes and --preview needs no network; a broken copy exits 1 with the reason.
const check = (dir, ...a) => spawnSync(process.execPath, [path.join(repo, "scripts/plugin-check.mjs"), dir, ...a], { encoding: "utf8" });
for (const name of ["speak-tick", "context-start", "block-tool", "late-tool"]) {
  const r = check(path.join(repo, "examples/plugins", name), "--preview");
  assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  assert.match(r.stdout, new RegExp(`^ok ${name} `));
}
assert.match(check(path.join(repo, "examples/plugins/speak-tick"), "--preview").stdout, /SYSTEM_EVENT_HOOK speak-tick\/remind: Remind the user to stretch\./);
assert.match(check(path.join(repo, "examples/plugins/context-start"), "--preview").stdout, /<plugin-notes>\nThe user works on the design team\.\n<\/plugin-notes>/);
assert.match(check(path.join(repo, "examples/plugins/late-tool"), "--preview").stdout, /"behavior": "NON_BLOCKING"/);
{
  const broken = path.join(home, "speak-tick");
  execFileSync("cp", ["-R", path.join(repo, "examples/plugins/speak-tick"), broken]);
  fs.writeFileSync(path.join(broken, "hooks/hooks.json"), JSON.stringify({ hooks: { Tick: [{ name: "remind", every_min: 2, hooks: [{ type: "speak", text: "Say {price}." }] }] } }));
  const r = check(broken);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "error: group remind hook 1 uses {price}, which is not a field");
}

fs.rmSync(home, { recursive: true, force: true });
console.log("examples selftest ok");
