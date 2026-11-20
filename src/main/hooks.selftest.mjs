// node hooks.selftest.mjs — plugin hooks (hooks.mjs): parsing (H1), commands and trust (H2), emit and scheduling (H3).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanPluginConfig, commandOutcome, createHooks, fill, hookPath, killCommands, loadPlugin, loadPlugins, parsePlugin, runCommand, SESSION_CONTEXT_MAX, trustCheck, trustHash,
} from "./hooks.mjs";

const meta = {
  name: "livestream", version: "0.2.0", open_iris_api: 1, description: "Co-host",
  fields: [{ key: "topic", label: "Chủ đề", max: 10 }, { key: "goal", label: "Mục tiêu" }],
  components: { hooks: "./hooks/hooks.json" },
};
const hooksDoc = {
  hooks: {
    SessionStart: [{ name: "brief", label: "Vai", hooks: [{ type: "context", text: "Co-host mode. Topic: {topic}. Goal: {goal}." }] }],
    Tick: [
      { name: "recap", every_min: 5, hooks: [{ type: "speak", text: "Recap now ({topic})." }] },
      { name: "cta", every_min: 7, hooks: [{ type: "speak", text: "Call to action for {goal}." }] },
    ],
  },
};
const parse = (m, doc) => parsePlugin("livestream", m, () => doc);

// --- H1: parsing ---
const p = parse(meta, hooksDoc);
assert.deepEqual(p.groups.map((g) => g.id), ["livestream/brief", "livestream/recap", "livestream/cta"]);
assert.equal(p.fields[1].max, 200); // default
assert.equal(p.groups[1].label, "recap"); // label falls back to the name
assert.equal(p.hasCommand, false);
assert.deepEqual(parse({ ...meta, components: undefined }, null).groups, []); // no components: nothing registered

const bad = (m, doc, re) => assert.throws(() => parse(m, doc), re);
const withEvent = (event, group) => ({ hooks: { [event]: [{ name: "g", ...group }] } });
bad({ ...meta, name: "other" }, hooksDoc, /must match the folder/);
bad({ ...meta, open_iris_api: undefined }, hooksDoc, /open_iris_api/); // missing key
bad({ ...meta, open_iris_api: 2 }, hooksDoc, /needs a newer open-iris/);
bad({ ...meta, components: { hooks: "./hooks/hooks.json", skills: "./skills" } }, hooksDoc, /components.skills is not supported/);
bad({ ...meta, components: { hooks: "./hooks/../../x.json" } }, hooksDoc, /inside the plugin folder/);
bad({ ...meta, components: { hooks: "/etc/hooks.json" } }, hooksDoc, /inside the plugin folder/);
bad({ ...meta, fields: [{ key: "a" }, { key: "a" }] }, hooksDoc, /repeated/);
bad(meta, { hooks: { Startup: [] } }, /unknown event Startup/);
bad(meta, withEvent("SessionStart", { hooks: [{ type: "context", text: "Price: {price}." }] }), /\{price\}, which is not a field/);
bad(meta, withEvent("SessionStart", { hooks: [{ type: "speak", text: "Hi." }] }), /speak hooks cannot be used on SessionStart/);
bad(meta, withEvent("Tick", { hooks: [{ type: "speak", text: "Hi." }] }), /every_min/);
bad(meta, withEvent("Tick", { every_min: 1, hooks: [{ type: "speak", text: "Hi." }] }), /every_min/);
bad(meta, withEvent("UserTurn", { every_min: 5, hooks: [{ type: "speak", text: "Hi." }] }), /every_min is only for Tick/);
bad(meta, withEvent("UserTurn", { matcher: "x", hooks: [{ type: "speak", text: "Hi." }] }), /matcher is only for/);
bad(meta, withEvent("PreToolCall", { matcher: "(", hooks: [{ type: "command", command: "true" }] }), /not a valid regex/);
bad(meta, withEvent("PreToolCall", { hooks: [{ type: "command", command: "true", timeout: 11 }] }), /timeout/);
bad(meta, withEvent("UserTurn", { hooks: [{ type: "context", text: "x".repeat(1001) }] }), /at most 1000/);
bad(meta, withEvent("UserTurn", { hooks: [] }), /1 to 5/);
bad(meta, withEvent("UserTurn", { hooks: [{ type: "shell", command: "true" }] }), /type must be/);
bad(meta, { hooks: { UserTurn: Array.from({ length: 21 }, (_, i) => ({ name: `g${i}`, hooks: [{ type: "context", text: "x" }] })) } }, /at most 20/);
assert.equal(parse(meta, withEvent("Tick", { every_min: 5, hooks: [{ type: "command", command: "true", timeout: 30 }] })).hasCommand, true);

// Fields: an empty field drops its whole sentence.
assert.equal(fill("Co-host mode. Topic: {topic}. Goal: {goal}.", { topic: "cats", goal: "" }), "Co-host mode. Topic: cats.");

// Config from IPC/file: unknown shapes dropped, every_min clamped, text kept on one line.
assert.deepEqual(cleanPluginConfig({
  livestream: { on: true, fields: { topic: " a\n b ", Bad: "x" }, groups: { recap: { on: true, every_min: 999 }, cta: { on: "yes" } } },
  "../x": { on: true },
}), { livestream: { on: true, fields: { topic: "a b" }, groups: { recap: { on: true, every_min: 60 }, cta: { on: false } }, tools: {} } });

// On disk: a temp home with plugins.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-hooks-"));
const writePlugin = (name, m, doc, files = {}) => {
  const dir = path.join(home, "plugins", name);
  fs.mkdirSync(path.join(dir, ".open-iris-plugin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".open-iris-plugin", "plugin.json"), JSON.stringify({ ...m, name }));
  if (doc) fs.writeFileSync(path.join(dir, "hooks", "hooks.json"), JSON.stringify(doc));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text, { mode: 0o755 });
  return dir;
};
writePlugin("livestream", meta, hooksDoc);
writePlugin("broken", { ...meta, open_iris_api: 9 }, hooksDoc);
const outside = path.join(home, "outside.json");
fs.writeFileSync(outside, JSON.stringify(hooksDoc));
const linked = writePlugin("linked", meta, null);
fs.symlinkSync(outside, path.join(linked, "hooks", "hooks.json"));
fs.mkdirSync(path.join(home, "plugins", ".livestream.adding")); // half-done install: skipped
const warnings = [];
const loaded = loadPlugins(home, (w) => warnings.push(w));
assert.deepEqual(loaded.map((x) => x.name), ["broken", "linked", "livestream"]); // name order
assert.match(loaded[0].error, /needs a newer open-iris/);
assert.match(loaded[1].error, /points outside the plugin folder/); // symlink escaping the folder
assert.equal(loaded[2].groups.length, 3);
assert.equal(warnings.length, 2);
assert.deepEqual(loadPlugins(path.join(home, "none")), []);

// --- H2: commands and trust ---
const sh = (code, input = {}, opts = {}) => runCommand(code, input, { cwd: home, env: { PATH: "/usr/bin:/bin" }, ...opts });
let r = await sh("cat >&2; exit 2", { tool: { name: "x" } });
assert.equal(r.code, 2);
assert.deepEqual(commandOutcome(r), { block: '{"tool":{"name":"x"}}' }); // stdin JSON reaches the script; stderr is the reason
r = await sh(`echo '{"decision":"block","reason":"no","hookSpecificOutput":{"additionalContext":"ctx"},"speak":"hi"}'`);
assert.deepEqual(commandOutcome(r), { block: "no", context: "ctx", speak: "hi" });
assert.deepEqual(commandOutcome(await sh("echo hello")), { note: "stdout is not JSON, ignored" });
assert.deepEqual(commandOutcome(await sh("true")), {});
assert.match(commandOutcome(await sh("echo bad >&2; exit 3")).failed, /exit 3: bad/);
const t0 = Date.now();
r = await sh("sleep 5", {}, { timeoutMs: 300 });
assert.ok(r.timedOut && Date.now() - t0 < 2000, "a hung hook is killed at its timeout");
assert.deepEqual(commandOutcome(r), { failed: "timed out" });
r = await sh("head -c 100000 /dev/zero | tr '\\0' a");
assert.equal(r.stdout.length, 64 * 1024); // output capped

// PATH: the app's PATH plus Homebrew's folders, no duplicates, no login shell.
assert.equal(hookPath("/usr/bin:/bin"), "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
assert.equal(hookPath("/opt/homebrew/bin:/usr/bin"), "/opt/homebrew/bin:/usr/bin:/usr/local/bin");
assert.equal(hookPath(""), "/opt/homebrew/bin:/usr/local/bin");

// Trust hash: whole folder, any 1-byte change alters it, .DS_Store does not.
const lsDir = path.join(home, "plugins", "livestream");
const h1 = trustHash(lsDir);
fs.writeFileSync(path.join(lsDir, ".DS_Store"), "finder");
assert.equal(trustHash(lsDir), h1);
fs.writeFileSync(path.join(lsDir, "README.md"), "a");
const h2 = trustHash(lsDir);
assert.notEqual(h2, h1);
fs.writeFileSync(path.join(lsDir, "README.md"), "b");
assert.notEqual(trustHash(lsDir), h2);

// A guard plugin with a real script, run through createHooks: env, stdin, block, fail closed.
const guardDir = writePlugin("guard", { ...meta, fields: [{ key: "apps" }] }, {
  hooks: {
    PreToolCall: [{ name: "block", matcher: "^open_", hooks: [{ type: "command", command: "./hooks/guard.sh" }] }],
    PostToolCall: [{ name: "env", hooks: [{ type: "command", command: "./hooks/env.sh" }] }],
  },
}, {
  "hooks/guard.sh": "#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *'\"app\":\"Mail\"'*) echo \"Mail is blocked\" >&2; exit 2;; esac\nexit 0\n",
  "hooks/env.sh": "#!/bin/sh\ncat > /dev/null\nprintf '{\"hookSpecificOutput\":{\"additionalContext\":\"%s|%s|%s|%s|%s\"}}' \"$PATH\" \"${GEMINI_API_KEY:-none}\" \"$IRIS_PLUGIN_ROOT\" \"$IRIS_PLUGIN_DATA\" \"$(pwd -P)\"\n",
});
process.env.GEMINI_API_KEY = "secret-key";
const guard = loadPlugin(guardDir);
const guardCfg = { guard: { on: true, fields: {}, groups: { block: { on: true }, env: { on: true } } } };
const logs = [];
const mk = (trust) => createHooks({ plugins: [guard], getConfig: () => guardCfg, trust, home, appPath: "/usr/bin:/bin", send: () => true, log: (l) => logs.push(l) });
let hooks = mk({ guard: trustHash(guardDir) });
let e = await hooks.emit("PreToolCall", { tool: { name: "open_or_focus_app", args: { app: "Mail" } } });
assert.deepEqual([e.block, e.reason, e.by], [true, "Mail is blocked", "guard/block"]);
assert.equal((await hooks.emit("PreToolCall", { tool: { name: "open_or_focus_app", args: { app: "Notes" } } })).block, false);
assert.equal((await hooks.emit("PreToolCall", { tool: { name: "read_app_text", args: { app: "Mail" } } })).block, false); // matcher
e = await hooks.emit("PostToolCall", { tool: { name: "x", args: {} }, result: {} });
const [envPath, key, root, data, cwd] = e.context.split("|");
assert.equal(envPath, "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
assert.equal(key, "none"); // the API key never reaches a hook
assert.equal(root, guard.dir);
assert.equal(data, path.join(home, "plugin-data", "guard"));
assert.ok(fs.statSync(data).isDirectory());
assert.equal(cwd, fs.realpathSync(guard.dir));
// Untrusted (never approved, or folder changed since): commands don't run, and PreToolCall fails closed.
for (const trust of [{}, { guard: h1 }]) {
  hooks = mk(trust);
  e = await hooks.emit("PreToolCall", { tool: { name: "open_or_focus_app", args: { app: "Notes" } } });
  assert.deepEqual([e.block, e.reason], [true, "guard/block failed: plugin is not trusted"]);
  assert.equal((await hooks.emit("PostToolCall", { tool: { name: "x" } })).context, "");
}

// --- H3: emit order, context, scheduling ---
// Core hooks run after plugins and can't be skipped; the first block stops the chain.
const order = [];
const ls = loaded[2];
const lsCfg = (groups) => ({ livestream: { on: true, fields: { topic: "cats", goal: "" }, groups } });
let cfg = lsCfg({ brief: { on: true } });
const core = { PreToolCall: [(pl) => (order.push("core"), pl.tool.name === "rm" ? { block: true, reason: "core says no" } : null)] };
hooks = createHooks({ plugins: [ls], getConfig: () => cfg, home, core, send: () => true });
e = await hooks.emit("SessionStart");
assert.deepEqual(e, { block: false, context: "Co-host mode. Topic: cats." }); // SessionStart context returned for the system instruction
assert.equal(hooks.speaks(), false); // K1: context only, no SYSTEM_EVENT_HOOK sentence
cfg = lsCfg({ brief: { on: true }, recap: { on: true } });
await hooks.emit("SessionStart");
assert.equal(hooks.speaks(), true); // a speak group on: the prompt explains the marker
cfg = lsCfg({ brief: { on: true } });
assert.deepEqual(await hooks.emit("PreToolCall", { tool: { name: "rm" } }), { block: true, reason: "core says no", by: "core", context: "" });
cfg = lsCfg({ brief: { on: false } });
assert.equal((await hooks.emit("SessionStart")).context, ""); // group switched off mid-run: config read at every event
cfg = { livestream: { ...lsCfg({ brief: { on: true } }).livestream, on: false } };
assert.equal((await hooks.emit("SessionStart")).context, ""); // whole plugin off

// SessionStart context has a total cap: 3 plugins × 5 × 1000 chars → whole pieces kept in plugin order, the rest dropped with a log.
{
  const big = (n) => parsePlugin(`big${n}`, { ...meta, name: `big${n}`, fields: [] }, () => ({
    hooks: { SessionStart: [{ name: "brief", hooks: Array.from({ length: 5 }, (_, i) => ({ type: "context", text: `${n}${i}`.padEnd(1000, ".") })) }] },
  }));
  const capLogs = [];
  const h = createHooks({ plugins: [big(1), big(2), big(3)], getConfig: () => Object.fromEntries([1, 2, 3].map((n) => [`big${n}`, { on: true, fields: {}, groups: { brief: { on: true } } }])), home, send: () => true, log: (l) => capLogs.push(l) });
  const text = (await h.emit("SessionStart")).context;
  assert.ok(text.length <= SESSION_CONTEXT_MAX && text.length > 3000, `capped length ${text.length}`);
  assert.ok(text.startsWith("10") && text.includes(" 12") && !text.includes(" 13"), "first plugin's pieces kept in order");
  assert.ok(capLogs.some((l) => / context=3002\/4000 dropped=12$/.test(l)), capLogs.join("|"));
}

// A plugin block comes before core; context from UserTurn goes to addContext.
const chainPlugin = parsePlugin("chain", { ...meta, name: "chain", fields: [] }, () => ({
  hooks: {
    PreToolCall: [
      { name: "stop", hooks: [{ type: "command", command: "x" }] },
      { name: "after", hooks: [{ type: "context", text: "Never reached." }] },
    ],
    UserTurn: [{ name: "note", hooks: [{ type: "context", text: "Keep it short." }] }],
  },
}));
chainPlugin.dir = home;
const added = [];
hooks = createHooks({
  plugins: [chainPlugin], home, core, trust: { chain: "h" }, hashOf: () => "h", addContext: (t) => added.push(t), send: () => true,
  getConfig: () => ({ chain: { on: true, fields: {}, groups: { stop: { on: true }, after: { on: true }, note: { on: true } } } }),
  run: async () => (order.push("plugin"), { code: 2, stdout: "", stderr: "plugin says no" }),
});
order.length = 0;
e = await hooks.emit("PreToolCall", { tool: { name: "rm" } });
assert.deepEqual([e.reason, e.by, order], ["plugin says no", "chain/stop", ["plugin"]]);
await hooks.emit("UserTurn", { text: "hi" });
assert.deepEqual(added, ["Keep it short."]);

// Fake clock: Tick and speak only after 4 s of quiet, 60 s apart, held in listen-only.
function clock() {
  let t = 0, fn = null;
  return {
    now: () => t,
    setInterval: (f) => ((fn = f), { unref() {} }),
    clearInterval: () => (fn = null),
    async run(sec) {
      for (let i = 0; i < sec; i++) {
        t += 1000;
        fn?.();
        await new Promise((res) => setImmediate(res));
      }
    },
  };
}
const ticking = (groups, send) => {
  const c = clock();
  cfg = lsCfg(groups);
  const hk = createHooks({ plugins: [ls], getConfig: () => cfg, home, send, now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval });
  return { c, hk };
};

// recap every 5 min, cta every 7 min (goal is empty, so cta's only sentence drops and it says nothing).
let sent = [];
let { c, hk } = ticking({ recap: { on: true }, cta: { on: true } }, (text) => sent.push([c.now(), text]));
hk.start();
await c.run(299);
assert.equal(sent.length, 0);
await c.run(2);
assert.deepEqual(sent, [[301_000, "SYSTEM_EVENT_HOOK livestream/recap: Recap now (cats)."]]);
cfg.livestream.fields.goal = "followers";
await c.run(120);
assert.deepEqual(sent.map((s) => s[0]), [301_000, 421_000]);
assert.equal(sent[1][1], "SYSTEM_EVENT_HOOK livestream/cta: Call to action for followers.");
hk.stop();
await c.run(600);
assert.equal(sent.length, 2); // stopped: nothing more

// Both due at 2 min (user override): 60 s apart, and talking holds the turn.
sent = [];
({ c, hk } = ticking({ recap: { on: true, every_min: 2 }, cta: { on: true, every_min: 2 } }, (text) => sent.push([c.now(), text])));
cfg.livestream.fields.goal = "likes";
hk.start();
await c.run(119);
hk.markActivity(); // someone speaks at 119 s
await c.run(10);
assert.deepEqual(sent.map((s) => s[0]), [123_000]); // waited 4 s of quiet after 119 s
await c.run(60);
assert.deepEqual(sent.map((s) => s[0]), [123_000, 183_000]); // second one 60 s later
assert.match(sent[0][1], /recap/);
assert.match(sent[1][1], /cta/);

// Listen-only: send returns false, the turn is kept and goes out once it is off.
sent = [];
let listenOnly = true;
({ c, hk } = ticking({ recap: { on: true } }, (text) => (listenOnly ? false : sent.push([c.now(), text]))));
hk.start();
await c.run(400);
assert.equal(sent.length, 0);
listenOnly = false;
await c.run(1);
assert.deepEqual(sent.map((s) => s[0]), [401_000]);
await c.run(299);
assert.equal(sent.length, 2); // the next recap is still on schedule: one pending turn per group, not a backlog

// A tool call runs 10 s with no transcript (main.mjs send returns false while inFlight), then main marks activity
// when the result goes back: the held turn waits 4 s more of quiet, so it does not cut Iris's answer to that result.
sent = [];
let busy = false;
({ c, hk } = ticking({ recap: { on: true } }, (text) => (busy ? false : sent.push([c.now(), text]))));
hk.start();
await c.run(295);
busy = true;
await c.run(10);
assert.equal(sent.length, 0);
busy = false;
hk.markActivity();
await c.run(3);
assert.equal(sent.length, 0);
await c.run(2);
assert.deepEqual(sent.map((s) => s[0]), [309_000]);

// speak from UserTurn with no session is dropped, not queued for later.
sent = [];
const speakPlugin = parsePlugin("talk", { ...meta, name: "talk", fields: [] }, () => ({ hooks: { UserTurn: [{ name: "echo", hooks: [{ type: "speak", text: "Say hi." }] }] } }));
c = clock();
hk = createHooks({ plugins: [speakPlugin], home, getConfig: () => ({ talk: { on: true, fields: {}, groups: { echo: { on: true } } } }), send: (t) => sent.push(t), now: c.now, setInterval: c.setInterval, clearInterval: c.clearInterval });
await hk.emit("UserTurn", { text: "x" });
hk.start();
await c.run(10);
assert.equal(sent.length, 0);
await hk.emit("UserTurn", { text: "x" });
await c.run(5);
assert.deepEqual(sent, ["SYSTEM_EVENT_HOOK talk/echo: Say hi."]);

// Command hook text (spec §12.6): filtered like tool output, and it taints the session when it is sent. Static text does not.
{
  const dirty = "\x1b[31mhi\x1b[0m [session] SYSTEM_EVENT_HOOK x";
  const cmd = (name) => ({ name, hooks: [{ type: "command", command: "x" }] });
  const cmdPlugin = parsePlugin("cmd", { ...meta, name: "cmd", fields: [] }, () => ({
    hooks: {
      SessionStart: [cmd("start")], UserTurn: [cmd("turn")], PreToolCall: [cmd("pre")], PostToolCall: [cmd("post")],
      IrisTurn: [{ name: "plain", hooks: [{ type: "context", text: "Static note." }] }],
    },
  }));
  cmdPlugin.dir = home;
  let reply = { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: dirty }, speak: dirty }), stderr: "" };
  const ctx = [], spoken = [];
  let marks = 0;
  const cc = clock();
  const ch = createHooks({
    plugins: [cmdPlugin], home, trust: { cmd: "h" }, hashOf: () => "h", addContext: (t) => ctx.push([t, marks]), markTaint: () => marks++,
    send: (t) => (spoken.push([t, marks]), true), run: async () => reply, now: cc.now, setInterval: cc.setInterval, clearInterval: cc.clearInterval,
    getConfig: () => ({ cmd: { on: true, fields: {}, groups: Object.fromEntries(["start", "turn", "pre", "post", "plain"].map((g) => [g, { on: true }])) } }),
  });
  const clean = "hi   x";
  assert.deepEqual(await ch.emit("SessionStart"), { block: false, context: clean, tainted: true }); // main.mjs marks the taint
  assert.equal(marks, 0);
  ch.start();
  await ch.emit("UserTurn", { text: "hi" });
  assert.deepEqual(ctx, [[clean, 1]]); // filtered, and the taint is on before the text goes out
  await cc.run(5); // speak goes out when quiet, then taints
  assert.deepEqual(spoken, [[`SYSTEM_EVENT_HOOK cmd/turn: ${clean}`, 1]]);
  assert.equal(marks, 2);
  assert.deepEqual(await ch.emit("PostToolCall", { tool: { name: "x" }, result: {} }), { block: false, context: clean, tainted: true });
  reply = { code: 2, stdout: "", stderr: dirty };
  e = await ch.emit("PreToolCall", { tool: { name: "x" } });
  assert.deepEqual([e.block, e.reason, e.tainted], [true, clean, true]);
  reply = { code: 3, stdout: "", stderr: dirty };
  assert.equal((await ch.emit("PreToolCall", { tool: { name: "x" } })).reason, `cmd/pre failed: exit 3: ${clean}`);
  marks = 0;
  assert.deepEqual(await ch.emit("IrisTurn", { text: "x" }), { block: false, context: "Static note." }); // static: no taint
  assert.equal(marks, 0);
  ch.stop();
}

// Symlinks (spec §6): one whose real path leaves the folder is refused by loadPlugin and trustHash, even an unused one.
{
  const sneaky = writePlugin("sneaky", meta, hooksDoc);
  fs.symlinkSync(outside, path.join(sneaky, "run.sh"));
  assert.throws(() => loadPlugin(sneaky), /run\.sh points outside the plugin folder/);
  assert.throws(() => trustHash(sneaky), /run\.sh points outside the plugin folder/);
  fs.rmSync(path.join(sneaky, "run.sh"));
  fs.symlinkSync("hooks/hooks.json", path.join(sneaky, "inside.json")); // inside the folder: fine
  assert.equal(loadPlugin(sneaky).name, "sneaky");
  trustHash(sneaky);
  fs.symlinkSync(path.join(home, "nothing"), path.join(sneaky, "gone"));
  assert.throws(() => trustHash(sneaky), /gone is a broken link/);
}

// Re-hash before each command hook run: a script edited mid-session stops running (fail closed), and runs again once restored.
{
  const guardSh = path.join(guardDir, "hooks", "guard.sh");
  const before = fs.readFileSync(guardSh, "utf8");
  hooks = mk({ guard: trustHash(guardDir) });
  const pre = () => hooks.emit("PreToolCall", { tool: { name: "open_or_focus_app", args: { app: "Notes" } } });
  assert.equal((await pre()).block, false);
  fs.appendFileSync(guardSh, "# changed\n");
  assert.deepEqual([(await pre()).reason], ["guard/block failed: plugin is not trusted"]);
  fs.writeFileSync(guardSh, before);
  assert.equal((await pre()).block, false);
}

// Process groups (spec §12.3): a background child dies with its hook after a normal close; killCommands ends running hooks.
{
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const pidFile = path.join(home, "bg.pid");
  r = await sh(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`);
  assert.equal(r.code, 0);
  const bg = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(bg), false, "background child killed after close");
  const running = sh("sleep 30", {}, { timeoutMs: 60_000 });
  await new Promise((res) => setTimeout(res, 200));
  const t1 = Date.now();
  killCommands();
  r = await running;
  assert.ok(Date.now() - t1 < 2000 && r.code !== 0, "killCommands ends a running hook");
}

// Switched off mid-session (docs/plugin-off-and-log-plan.md §1): a queued speak, a tool call and a queued late result stop at once.
{
  const offMeta = { ...meta, name: "sw", fields: [], components: { hooks: "./hooks/hooks.json", tools: "./tools.json" } };
  const sw = parsePlugin("sw", offMeta, () => ({
    hooks: { UserTurn: [{ name: "echo", hooks: [{ type: "speak", text: "Say hi." }] }] },
    tools: [{ name: "job", description: "Job.", command: "sh ./job.sh", parameters: { type: "object", properties: {} } }],
  }));
  const swCfg = { sw: { on: true, fields: {}, groups: { echo: { on: true } }, tools: { job: { on: true } } } };
  const swLogs = [], swSent = [];
  let spawned = 0;
  const sc = clock();
  const sh = createHooks({
    plugins: [sw], home, getConfig: () => swCfg, trust: { sw: "h" }, hashOf: () => "h", log: (l) => swLogs.push(l),
    run: async () => { spawned++; return { code: 0, stdout: JSON.stringify({ ok: true, output: "ok" }), stderr: "" }; },
    send: (t) => swSent.push(t), now: sc.now, setInterval: sc.setInterval, clearInterval: sc.clearInterval,
  });
  swCfg.sw.groups.echo.on = false;
  await sh.emit("SessionStart");
  assert.equal(sh.speaks(), false); // a tool without late does not speak
  swCfg.sw.groups.echo.on = true;
  await sh.emit("SessionStart");
  sh.start();
  const job = sh.tools().find((t) => t.name === "sw__job");
  // A: a queued speak of a group switched off before it is sent is dropped.
  await sh.emit("UserTurn", { text: "x" });
  swCfg.sw.groups.echo.on = false;
  await sc.run(10);
  assert.deepEqual(swSent, [], "A: speak of a switched-off group is not sent");
  assert.ok(swLogs.includes("hook sw/echo: switched off, speak dropped"));
  // C: a queued late result of a tool switched off before it is sent is dropped.
  sh.later("sw__job", "late text");
  swCfg.sw.tools.job.on = false;
  await sc.run(10);
  assert.deepEqual(swSent, [], "C: late result of a switched-off tool is not sent");
  // B: Gemini calls a switched-off tool: nothing runs.
  assert.deepEqual(await job.run({}, {}), { ok: false, error: "tool switched off by the user" });
  assert.equal(spawned, 0, "B: a switched-off tool does not spawn");
  swCfg.sw.tools.job.on = true;
  assert.equal((await job.run({}, {})).ok, true);
  assert.equal(spawned, 1);
  sh.stop();
}

// main.log says what each plugin adds, by name and size only, never the hook text (docs/plugin-off-and-log-plan.md §2).
{
  const lgMeta = { ...meta, name: "lg", fields: [], components: { hooks: "./hooks/hooks.json", tools: "./tools.json" } };
  const lg = parsePlugin("lg", lgMeta, () => ({
    hooks: {
      SessionStart: [{ name: "brief", hooks: [{ type: "context", text: "SECRET_TEXT brief" }] }],
      PreToolCall: [{ name: "guard", hooks: [{ type: "context", text: "SECRET_TEXT guard" }] }],
      Tick: [{ name: "recap", every_min: 10, hooks: [{ type: "speak", text: "SECRET_TEXT recap" }] }],
    },
    tools: [{ name: "job", description: "Job.", brief: "SECRET_TEXT tool", command: "sh ./job.sh", parameters: { type: "object", properties: {} } }],
  }));
  const lgCfg = { lg: { on: true, fields: {}, groups: { brief: { on: true }, guard: { on: true }, recap: { on: true, every_min: 5 } }, tools: { job: { on: true } } } };
  const lgLogs = [];
  const lh = createHooks({ plugins: [lg], home, getConfig: () => lgCfg, trust: { lg: "h" }, hashOf: () => "h", log: (l) => lgLogs.push(l), send: () => true });
  const st = await lh.emit("SessionStart");
  await lh.emit("PreToolCall", { tool: { name: "click_app_control", args: {} } });
  assert.deepEqual(lgLogs, [
    "hook lg/brief context +17 chars on SessionStart",
    `session groups=lg/brief@SessionStart,lg/guard@PreToolCall,lg/recap@Tick/5m tools=lg__job context=${st.context.length}/${SESSION_CONTEXT_MAX} dropped=0`,
    "hook lg/guard context +17 chars on PreToolCall click_app_control",
  ]);
  assert.ok(lgLogs.every((l) => !l.includes("SECRET_TEXT")), "no hook text in main.log");
}

fs.rmSync(home, { recursive: true, force: true });
console.log("hooks selftest ok");

// trustCheck re-reads file bytes only after a file changed
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-trust-"));
  fs.writeFileSync(path.join(dir, "a.sh"), "echo hi");
  let hashes = 0;
  const check = trustCheck({ t: trustHash(dir) }, (d) => (hashes++, trustHash(d)));
  const p = { name: "t", dir };
  assert.ok(check(p));
  assert.ok(check(p));
  assert.equal(hashes, 1); // unchanged folder: no second full hash
  fs.writeFileSync(path.join(dir, "a.sh"), "echo evil");
  assert.ok(!check(p)); // changed: hashed again and refused
  assert.equal(hashes, 2);
  fs.writeFileSync(path.join(dir, "b.sh"), "new file");
  assert.ok(!check(p));
  assert.ok(!trustCheck({}, () => "x")(p)); // never trusted
  fs.rmSync(dir, { recursive: true, force: true });
}
