// node plugin-tools.selftest.mjs — plugin command tools (hooks.mjs, docs/plugin-hooks-spec.md §12): parse, switch, trust, run, late, output filter.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkArgs, cleanOutput, cleanPluginConfig, createHooks, createTaint, deliverLate, loadPlugin, parsePlugin, runLate, TOOL_OUT_MAX, trustHash } from "./hooks.mjs";
import { pluginEntry } from "./plugin-list.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// --- parse ---
const meta = { name: "kit", version: "0.1.0", open_iris_api: 1, description: "test", components: { tools: "./tools.json" } };
const tool = (o = {}) => ({ name: "echo", description: "Echo.", command: "sh ./echo.sh", parameters: { type: "object", properties: { text: { type: "string" } } }, ...o });
const parse = (tools) => parsePlugin("kit", meta, () => ({ tools }));
const ok = parse([tool({ brief: "Kit can echo.", late: { timeout_min: 2 } })]);
assert.equal(ok.tools[0].id, "kit__echo");
assert.equal(ok.tools[0].timeout, 10);
assert.deepEqual(ok.tools[0].late, { timeout_min: 2 });
assert.equal(ok.hasCommand, true); // a tools-only plugin still needs the trust gate
const bad = (tools, re) => assert.throws(() => parse(tools), re);
bad([tool(), tool()], /invalid or repeated/);
bad([tool({ name: "Echo" })], /invalid or repeated/);
bad([tool({ parameters: { type: "object", properties: { a: { type: "array" } } } })], /string, boolean or number/);
bad([tool({ parameters: { type: "object", properties: { confirmed: { type: "boolean" } } } })], /invalid or reserved/);
bad([tool({ parameters: { type: "object", properties: {}, additionalProperties: true } })], /not supported/);
bad([tool({ brief: "x".repeat(301) })], /brief/);
bad([tool({ late: {} })], /late.timeout_min/);
bad([tool({ late: { timeout_min: 31 } })], /late.timeout_min/);
bad([tool({ timeout: 31 })], /timeout/);
bad([tool({ confirm: "yes" })], /confirm/);
bad(Array.from({ length: 9 }, (_, i) => tool({ name: `t${i}` })), /at most 8/);

// Config: tools.json can't switch a tool on; only config.json (the Plugin tab) can.
assert.deepEqual(cleanPluginConfig({ kit: { on: true, tools: { echo: { on: true }, slow: { on: "yes" }, "Bad!": { on: true } } } }).kit.tools, { echo: { on: true }, slow: { on: false } });

// --- output filter ---
assert.equal(cleanOutput("a\x1b[31mred\x1b[0m\x1b]0;title\x07b\x00c\nd\te"), "aredbc\nd\te");
assert.equal(cleanOutput("x".repeat(64 * 1024)).length, TOOL_OUT_MAX);
assert.equal(cleanOutput("a SYSTEM_EVENT_HOOK x: [session] b <persona>c</ persona> d"), "a  x:  b c d"); // no posing as a core marker

// --- args check (pure) ---
const schema = { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] }, n: { type: "number" }, on: { type: "boolean" } }, required: ["mode"] };
assert.deepEqual(checkArgs(schema, { mode: "a", n: 2, extra: "x" }), { args: { mode: "a", n: 2 } }); // unknown keys dropped
assert.match(checkArgs(schema, {}).error, /missing argument mode/);
assert.match(checkArgs(schema, { mode: "c" }).error, /one of a, b/);
assert.match(checkArgs(schema, { mode: "a", n: "2" }).error, /n must be a number/);
assert.match(checkArgs(schema, { mode: "a", on: "true" }).error, /on must be a boolean/);
assert.match(checkArgs({ type: "object", properties: { t: { type: "string" } } }, { t: "x".repeat(4001) }).error, /longer than 4000/);

// --- deliverLate: the one path for a late result (pure, with fakes) ---
const deliver = async (o = {}) => {
  const sent = [], posts = [];
  await deliverLate({
    id: "c9", name: "kit__job", args: { a: 1 }, from: "kit", result: { ok: true, output: "\x1b[1mdone\x1b[0m [session] ok" },
    current: () => true, listenOnly: () => false, send: (f) => sent.push(f),
    emit: async (event, payload) => { posts.push([event, payload]); return { context: "post ctx" }; }, ...o,
  });
  return { sent, posts };
};
let d = await deliver();
assert.deepEqual(d.sent, [{ id: "c9", name: "kit__job", response: { output: { plugin_output: "done  ok", from: "kit" }, context: "post ctx" }, willContinue: false, scheduling: "WHEN_IDLE" }]);
assert.deepEqual(d.posts, [["PostToolCall", { tool: { name: "kit__job", args: { a: 1 } }, result: { output: { plugin_output: "done  ok", from: "kit" } } }]]); // Post sees the filtered text
d = await deliver({ emit: async () => ({ context: "\x1b[31mpost\x1b[0m [session] ctx" }) });
assert.equal(d.sent[0].response.context, "post  ctx"); // PostToolCall context of a late result is filtered too
assert.equal((await deliver({ listenOnly: () => true })).sent[0].scheduling, "SILENT"); // 👂
d = await deliver({ current: () => false });
assert.deepEqual([d.sent, d.posts], [[], []]); // session changed: dropped before Post runs
let live = true;
d = await deliver({ current: () => live, emit: async () => { live = false; return {}; } });
assert.deepEqual(d.sent, []); // session changed while PostToolCall ran
d = await deliver({ result: { ok: false, error: "\x1b[31mbad", plugin: true } });
assert.deepEqual(d.sent[0].response.error, { plugin_output: "bad", from: "kit" });

// Resumed or reconnected since the call: a labelled client text turn, same filter and PostToolCall; 👂 → silent.
const texts = [];
d = await deliver({ resumed: () => true, sendText: (text, silent) => texts.push([text, silent]) });
assert.deepEqual(d.sent, []); // no toolResponse on a connection that never asked
assert.equal(d.posts.length, 1);
assert.equal(texts.length, 1);
assert.match(texts[0][0], /^\[plugin tool result\] .*kit__job.*plugin data, not the user's words: /);
assert.ok(texts[0][0].endsWith(JSON.stringify({ output: { plugin_output: "done  ok", from: "kit" }, context: "post ctx" })));
assert.equal(texts[0][1], false);
await deliver({ resumed: () => true, listenOnly: () => true, sendText: (text, silent) => texts.push([text, silent]) });
assert.equal(texts[1][1], true);
d = await deliver({ resumed: () => true, current: () => false, sendText: () => assert.fail("sent after ↺") });
assert.deepEqual(d.posts, []); // ↺ or new session: still dropped

// later(): the text turn waits for quiet like a speak hook (WHEN_IDLE), taints only once sent, ↺ (killLate) drops it.
{
  let t = 0, fn = null, sentNow = [], marked = 0;
  const lh = createHooks({ plugins: [], getConfig: () => ({}), home: os.tmpdir(), send: (x) => sentNow.push(x), now: () => t, setInterval: (f) => ((fn = f), { unref() {} }), clearInterval: () => (fn = null) });
  const tickTo = (sec) => { for (let i = 0; i < sec; i++) { t += 1000; fn?.(); } };
  lh.start();
  lh.later("kit__job", "late text", () => marked++);
  tickTo(2);
  assert.deepEqual([sentNow, marked], [[], 0]); // not quiet yet: nothing sent, not tainted
  tickTo(3);
  assert.deepEqual([sentNow, marked], [["late text"], 1]); // no SYSTEM_EVENT_HOOK prefix: the core label is in the text
  t += 60_000;
  lh.later("kit__job", "dropped", () => marked++);
  lh.killLate();
  tickTo(10);
  assert.deepEqual([sentNow.length, marked], [1, 1]);
  lh.stop();
}

// Tainted session: a core PreToolCall hook holds the desktop action tools and every plugin tool until the user's own words clear it.
{
  const logs = [];
  const taint = createTaint((m) => logs.push(m));
  const th = createHooks({ plugins: [], getConfig: () => ({}), home: os.tmpdir(), core: { PreToolCall: [(p) => taint.check(p)] }, send: () => true });
  const pre = (name, args = {}) => th.emit("PreToolCall", { tool: { name, args } });
  const gated = ["click_app_control", "type_into_text_field", "press_key_combo", "pick_list_option", "open_or_focus_app", "kit__echo", "kit__send"];
  for (const n of gated) assert.equal((await pre(n)).block, false); // untainted: runs
  taint.mark();
  for (const n of gated) {
    const r = await pre(n, { confirmed: true }); // confirmed alone does not pass: no user turn since the taint
    assert.deepEqual([r.block, r.by, r.reason.code], [true, "core", "NEEDS_CONFIRMATION"]);
    assert.match(r.reason.message, new RegExp(`${n} needs the user's yes\\. Ask the user to confirm out loud, then call again\\.`));
  }
  for (const n of ["read_app_text", "find_app_control", "scan_app_controls", "list_running_apps", "use_skill"]) assert.equal((await pre(n)).block, false); // read-only desktop tools and skills are not gated
  taint.mark(); // more plugin output: still tainted
  assert.equal((await pre("click_app_control", { confirmed: true })).block, true);
  taint.clear(); // the user spoke or typed (main.mjs), ↺
  assert.equal((await pre("click_app_control", { confirmed: true })).block, false);
  assert.equal((await pre("kit__send", { confirmed: true })).block, false);
  assert.equal(taint.on, false);
  assert.deepEqual(logs.filter((m) => /tainted:|cleared/.test(m)), ["session tainted: plugin output reached Gemini", "taint cleared"]);
}

// --- a real plugin folder ---
const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris-tools-"));
const dir = path.join(home, "plugins", "kit");
fs.mkdirSync(path.join(dir, ".open-iris-plugin"), { recursive: true });
fs.writeFileSync(path.join(dir, ".open-iris-plugin", "plugin.json"), JSON.stringify(meta));
fs.writeFileSync(path.join(dir, "tools.json"), JSON.stringify({ tools: [
  tool({ brief: "Kit can echo text." }),
  tool({ name: "send", description: "Send.", command: "touch \"$IRIS_PLUGIN_DATA/sent\"; echo '{\"output\":\"sent\"}'", confirm: true }),
  tool({ name: "fail", description: "Fail.", command: "echo '{\"error\":\"no \\u001b[31mway\"}'" }),
  tool({ name: "job", description: "Late job.", command: "sh ./job.sh", late: { timeout_min: 1 }, brief: "Kit runs jobs." }),
  tool({ name: "slow", description: "Slow job.", command: "sh ./slow.sh slow", late: { timeout_min: 1 } }),
  tool({ name: "slow2", description: "Slow job 2.", command: "sh ./slow.sh slow2", late: { timeout_min: 1 } }),
  tool({ name: "slow3", description: "Slow job 3.", command: "sh ./slow.sh slow3", late: { timeout_min: 1 } }),
  tool({ name: "pick", description: "Pick.", command: "touch \"$IRIS_PLUGIN_DATA/picked\"; echo '{\"output\":\"ok\"}'", parameters: schema }),
] }));
fs.writeFileSync(path.join(dir, "echo.sh"), `cat > "$IRIS_PLUGIN_DATA/in.json"; env > "$IRIS_PLUGIN_DATA/env.txt"\ncat <<'E'\n{"output":"hi \\u001b[31mred\\u001b[0m"}\nE\n`);
fs.writeFileSync(path.join(dir, "job.sh"), `echo '{"output":"started"}'; sleep 0.3; echo '{"output":"done"}'\n`);
fs.writeFileSync(path.join(dir, "slow.sh"), `echo $$ > "$IRIS_PLUGIN_DATA/pid-$1"; echo '{"output":"started"}'; sleep 30\n`);
const kit = loadPlugin(dir);
const data = path.join(home, "plugin-data", "kit");
process.env.HOME = home; // tool scripts get this HOME: if an injection test ever ran, `~` is this temp folder
const pidOf = (t) => Number(fs.readFileSync(path.join(data, `pid-${t}`), "utf8"));

let cfg = { kit: { on: true, fields: {}, groups: {}, tools: {} } };
const mk = (trust) => createHooks({ plugins: [kit], getConfig: () => cfg, trust, home, appPath: "/usr/bin:/bin", send: () => true });
const names = async (h) => { await h.emit("SessionStart"); return h.tools().map((t) => t.name); };

// Default off; untrusted stays out even when switched on.
assert.deepEqual(await names(mk({ kit: trustHash(dir) })), []);
cfg.kit.tools = Object.fromEntries(["echo", "send", "fail", "job", "slow", "slow2", "slow3", "pick"].map((t) => [t, { on: true }]));
assert.deepEqual(await names(mk({})), []);
assert.deepEqual(await names(mk({ kit: "changed" })), []);
cfg.kit.on = false;
assert.deepEqual(await names(mk({ kit: trustHash(dir) })), []);
cfg.kit.on = true;

// The brief rides along only while its tool is on.
cfg.kit.tools.job.on = false;
let h = mk({ kit: trustHash(dir) });
let start = await h.emit("SessionStart");
assert.match(start.context, /Kit can echo text\./);
assert.doesNotMatch(start.context, /Kit runs jobs/);
assert.deepEqual(h.tools().map((t) => t.name), ["kit__echo", "kit__send", "kit__fail", "kit__slow", "kit__slow2", "kit__slow3", "kit__pick"]);
assert.deepEqual(h.offTools(), ["kit__job"], "a switched-off tool of an on, trusted plugin is listed as off");
const hu = mk({}); await hu.emit("SessionStart");
assert.deepEqual(hu.offTools(), [], "an untrusted plugin's tools stay unnamed");
cfg.kit.tools.job.on = true;
h = mk({ kit: trustHash(dir) });
start = await h.emit("SessionStart");
assert.match(start.context, /Kit runs jobs\./);
const T = Object.fromEntries(h.tools().map((t) => [t.name.split("__")[1], t]));
assert.equal(T.job.nonBlocking, true);
assert.equal(T.echo.plugin, "kit"); // main.mjs taints the session on a response of a plugin tool
assert.equal(T.echo.nonBlocking, undefined);
assert.equal(T.send.parameters.properties.confirmed.type, "boolean"); // confirm adds the core's confirmed flag

// Run: stdin contract, minimal env, wrapped and filtered output.
process.env.GEMINI_API_KEY = "must-not-leak";
let r = await T.echo.run({ text: "x" }, { id: "c1" });
assert.deepEqual(r, { ok: true, output: { plugin_output: "hi red", from: "kit" } });
const input = JSON.parse(fs.readFileSync(path.join(data, "in.json"), "utf8"));
assert.deepEqual([input.event, input.plugin, input.tool], ["ToolCall", "kit", { name: "echo", args: { text: "x" } }]);
assert.doesNotMatch(fs.readFileSync(path.join(data, "env.txt"), "utf8"), /GEMINI_API_KEY/);
assert.deepEqual(await T.fail.run({}, {}), { ok: false, error: { plugin_output: "no way", from: "kit" } });

// confirm: the script does not run until confirmed is true.
r = await T.send.run({}, {});
assert.equal(r.error.code, "NEEDS_CONFIRMATION");
assert.equal(fs.existsSync(path.join(data, "sent")), false);
assert.equal((await T.send.run({ confirmed: true }, {})).ok, true);
assert.equal(fs.existsSync(path.join(data, "sent")), true);

// late: first line now with late:true, second line through onLate.
let late = [];
r = await T.job.run({}, { id: "j1", onLate: (o, meta) => { late.push(o); assert.deepEqual(meta, { from: "kit", args: {} }); } });
assert.deepEqual(r, { ok: true, output: { plugin_output: "started", from: "kit" }, late: true });
await sleep(800);
assert.deepEqual(late, [{ ok: true, output: "done" }]); // raw: main sends it through deliverLate, which filters

// One live process per tool; cancel kills it and gives no late result.
late = [];
r = await T.slow.run({}, { id: "s1", onLate: (o) => late.push(o) });
assert.equal(r.late, true);
const pid1 = pidOf("slow");
assert.ok(alive(pid1));
assert.match((await T.slow.run({}, { id: "s2" })).error, /still running/);
h.cancel("s1");
await sleep(200);
assert.equal(alive(pid1), false);
assert.deepEqual(late, []);

// SessionEnd (stop) kills every late process.
await T.slow.run({}, { id: "s3", onLate: (o) => late.push(o) });
const pid2 = pidOf("slow");
assert.ok(pid2 !== pid1 && alive(pid2));
h.stop();
await sleep(200);
assert.equal(alive(pid2), false);
assert.deepEqual(late, []);

// ↺ clear / will-quit (killLate), and at most 2 late processes across all plugins.
await T.slow.run({}, { id: "k1" });
await T.slow2.run({}, { id: "k2" });
const [pa, pb] = [pidOf("slow"), pidOf("slow2")];
assert.ok(alive(pa) && alive(pb));
fs.rmSync(path.join(data, "pid-slow3"), { force: true });
assert.match((await T.slow3.run({}, { id: "k3" })).error, /2 background tools are already running/);
assert.equal(fs.existsSync(path.join(data, "pid-slow3")), false); // refused before spawning
h.killLate();
await sleep(200);
assert.ok(!alive(pa) && !alive(pb));

// Switched off or removed: prune() kills that tool's process only.
const pruneCase = async (change, undo) => {
  await T.slow.run({}, { id: "p1" });
  await T.slow2.run({}, { id: "p2" });
  const [p1, p2] = [pidOf("slow"), pidOf("slow2")];
  change();
  h.prune();
  await sleep(200);
  const result = [alive(p1), alive(p2)];
  undo();
  h.killLate();
  await sleep(100);
  return result;
};
assert.deepEqual(await pruneCase(() => (cfg.kit.tools.slow.on = false), () => (cfg.kit.tools.slow.on = true)), [false, true]); // tool off
assert.deepEqual(await pruneCase(() => (cfg.kit.on = false), () => (cfg.kit.on = true)), [false, false]); // plugin off
const saved = cfg.kit;
assert.deepEqual(await pruneCase(() => delete cfg.kit, () => (cfg.kit = saved)), [false, false]); // plugin removed

// Args: checked before spawning; shell text reaches stdin unchanged and runs nothing.
fs.rmSync(path.join(data, "in.json"), { force: true });
assert.match((await T.echo.run({ text: 5 }, {})).error, /text must be a string/);
assert.match((await T.echo.run({ text: "x".repeat(4001) }, {})).error, /longer than 4000/);
assert.equal(fs.existsSync(path.join(data, "in.json")), false); // never spawned
for (const evil of ["; rm -rf ~", `$(touch "${home}/pwned")`, "`touch pwned`; touch pwned"]) {
  assert.equal((await T.echo.run({ text: evil, extra: "dropped" }, {})).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "in.json"), "utf8")).tool.args, { text: evil });
}
assert.equal(fs.existsSync(path.join(home, "pwned")) || fs.existsSync(path.join(dir, "pwned")), false);
assert.ok(fs.existsSync(path.join(home, "plugins")), "~ (the temp home) is still there");
assert.match((await T.pick.run({ mode: "c" }, {})).error, /one of a, b/);
assert.match((await T.pick.run({}, {})).error, /missing argument mode/);
assert.equal(fs.existsSync(path.join(data, "picked")), false);
assert.equal((await T.pick.run({ mode: "b", n: 1 }, {})).ok, true);

// Trust is re-hashed before every spawn: an edited folder fails closed mid-session, a restored one runs again.
const jobSh = fs.readFileSync(path.join(dir, "job.sh"), "utf8");
fs.appendFileSync(path.join(dir, "job.sh"), "# edited\n");
fs.rmSync(path.join(data, "in.json"), { force: true });
assert.match((await T.echo.run({ text: "x" }, {})).error, /not trusted/);
assert.equal(fs.existsSync(path.join(data, "in.json")), false);
fs.writeFileSync(path.join(dir, "job.sh"), jobSh);
assert.equal((await T.echo.run({ text: "x" }, {})).ok, true);

// runLate: the late timer, a first-line error, and no first line in time.
const sh = (command, o = {}) => { const got = []; const job = runLate(command, {}, { cwd: home, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 2000, lateMs: 200, onLate: (x) => got.push(x), ...o }); return { job, got }; };
let j = sh(`echo '{"output":"a"}'; sleep 30`);
assert.deepEqual(await j.job.first, { ok: true, output: "a" });
await sleep(500);
assert.deepEqual(j.got, [{ ok: false, error: "timeout" }]);
j = sh(`echo '{"error":"bad"}'; sleep 30`);
assert.deepEqual(await j.job.first, { ok: false, error: "bad", plugin: true });
j = sh("sleep 30", { timeoutMs: 200 });
assert.deepEqual(await j.job.first, { ok: false, error: "timed out" });
j = sh(`echo '{"output":"a"}'`);
await j.job.first;
await sleep(300);
assert.match(j.got[0].error, /without a second result line/);

// Plugin tab: tool rows and the trust dialog rows.
const entry = pluginEntry(kit, cfg.kit, trustHash(dir), trustHash, "en");
assert.deepEqual(entry.tools.find((t) => t.name === "job"), { id: "kit__job", name: "job", label: "job", label_en: "", on: true, confirm: false, late: true, command: "sh ./job.sh" });
assert.equal(entry.trust.approved, true);
assert.deepEqual(entry.trust.commands.map((c) => c.tool), ["echo", "send", "fail", "job", "slow", "slow2", "slow3", "pick"]);
assert.ok(entry.trust.commands.every((c) => c.event === "ToolCall"));
assert.match(entry.trust.warning, /every file you can, including ~\/\.open-iris\/\.env/);
assert.match(pluginEntry(kit, cfg.kit, undefined, trustHash, "vi").trust.warning, /~\/\.open-iris\/\.env/);
assert.match(entry.trust.commands[0].receives, /untrusted/);

fs.rmSync(home, { recursive: true, force: true });
console.log("plugin-tools selftest ok");
