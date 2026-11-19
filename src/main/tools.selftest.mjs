// node tools.selftest.mjs — checks config cleaning, that only the picked session terminal is driven, that
// status returns only a state, and that replies are Claude's assistant text only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopTools } from "./desktop.mjs";
import { cleanTools, extractHistory, extractReply, followUpToSend, listSessions, openSession, registry, REPLY_MAX, responsesToSend, TOOL_DEFAULTS, toSpeech, VOICE_BRIEF } from "./tools.mjs";

assert.deepEqual(cleanTools(), TOOL_DEFAULTS);
assert.deepEqual(cleanTools({ stop_coding_task: 1, evil: true, orca_delegate: true }), { ...TOOL_DEFAULTS, stop_coding_task: true });
// Every tool has its own switch, and a config saved with the old names keeps its choices.
assert.deepEqual(Object.keys(TOOL_DEFAULTS), [...desktopTools().map((t) => t.name), ...registry().map((t) => t.name)]);
assert.deepEqual(cleanTools({ do_task: true, task_status: false }), { ...TOOL_DEFAULTS, start_coding_task: true, check_coding_task_status: false });

const SECRET = "company screen content";
// Shape of `orca orchestration worker-read --source transcript --json` (trimmed from a real read).
const transcript = {
  ok: true,
  result: {
    transcript: {
      messages: [
        { role: "user", blocks: [{ type: "text", text: "old prompt" }] },
        { role: "assistant", blocks: [{ type: "text", text: "old answer" }] },
        { role: "user", blocks: [{ type: "text", text: "tạo file hello.txt" }] },
        { role: "assistant", blocks: [{ type: "text", text: "Creating it." }, { type: "tool-call", name: "Write", input: { content: SECRET } }] },
        { role: "tool", blocks: [{ type: "tool-result", output: SECRET }] },
        { role: "assistant", blocks: [{ type: "text", text: "Done: hello.txt created." }, { type: "tool-call", name: "Bash", input: { command: SECRET } }] },
        { role: "tool", blocks: [{ type: "tool-result", output: SECRET }] },
      ],
    },
  },
};
const msgs = transcript.result.transcript.messages;
assert.equal(extractReply(msgs), "Done: hello.txt created.");
assert.equal(extractReply(msgs.slice(0, 3)), "", "no reply yet after the latest prompt");
assert.equal(extractReply(null), "");
// Markdown is flattened for speech; plain text passes through.
assert.equal(toSpeech("## Tóm tắt\n\n| Tên | Giá |\n|---|---:|\n| A | 1 |\n\n**Xem** [docs](https://x.y/z) `npm i`\n```js\nx()\n```"), "Tóm tắt\n\nTên, Giá\n\nA, 1\n\nXem docs npm i\n(code omitted)");
assert.equal(toSpeech("Trời nắng, 30 độ - không mưa."), "Trời nắng, 30 độ - không mưa.");
// History: user prompts (voice brief stripped) with the final text reply of each turn; tool output never.
assert.equal(extractHistory(msgs), "User: old prompt\nClaude: old answer\n\nUser: tạo file hello.txt\nClaude: Done: hello.txt created.");
assert.equal(extractHistory(msgs, 1), "User: tạo file hello.txt\nClaude: Done: hello.txt created.");
assert.equal(extractHistory([{ role: "user", blocks: [{ type: "text", text: "x" + VOICE_BRIEF }] }]), "User: x\nClaude: (no text reply)");
assert.ok(!extractHistory(msgs).includes(SECRET));
// Command output stored as user text is neither history nor the latest prompt.
const withCmd = [...msgs.slice(0, 6), { role: "user", blocks: [{ type: "text", text: `<bash-stdout>${SECRET}</bash-stdout>` }] }];
assert.ok(!extractHistory(withCmd).includes(SECRET));
assert.equal(extractReply(withCmd), "Done: hello.txt created.");
// Prompt out of the read window: history still has the reply.
assert.equal(extractHistory(msgs.slice(3)), "User: (earlier request)\nClaude: Done: hello.txt created.");
assert.equal(extractReply([{ role: "user", blocks: [] }, { role: "assistant", blocks: [{ type: "text", text: "x".repeat(REPLY_MAX + 1000) }] }]).length, REPLY_MAX);

let terminals = [
  { title: "✳ voice", handle: "h1", connected: true, writable: true, agentIdentity: "claude", worktreePath: "/w/a", preview: SECRET },
  { title: "gone", handle: "h4", connected: false, writable: true, agentIdentity: "claude", worktreePath: "/w/a" },
  { title: "company-work", handle: "h9", connected: true, writable: true, worktreePath: "/w/c", preview: SECRET },
];
function fakeExec(waitResult, readResults = [transcript]) {
  const calls = [];
  const reads = [...readResults];
  const exec = async (args) => {
    calls.push(args);
    const ok = (result) => ({ json: { ok: true, result } });
    if (args[1] === "list") return { json: { ok: true, result: { terminals } } };
    if (args[1] === "wait") return { json: waitResult };
    if (args[1] === "send") return ok({ screen: SECRET });
    if (args[1] === "create") return ok({ terminal: { handle: "mbox" } });
    if (args[1] === "close") return ok({});
    if (args[1] === "run-create") return ok({ runId: "run_1" });
    if (args[1] === "task-create") return ok({ taskId: "task_1" });
    if (args[1] === "dispatch") return ok({ dispatch: { id: "ctx_1" } });
    if (args[1] === "worker-read") return { json: reads.length > 1 ? reads.shift() : reads[0] };
    if (args[1] === "worker-list") return ok({ workers: [{ dispatchId: "ctx_old", terminal: "h1", outcome: "succeeded" }, { dispatchId: "ctx_live", terminal: "h9", outcome: "in_progress" }] });
    throw new Error("unexpected");
  };
  return { exec, calls };
}
const tools = (exec, session = "h1") => registry(exec, session);
const tool = (exec, name) => tools(exec).find((t) => t.name === name);

// No tool takes a target: only the picked session can be driven.
assert.ok(tools(fakeExec({}).exec).every((t) => !("target" in t.parameters.properties)));

// Status returns only the state string; the disconnected duplicate is ignored.
let f = fakeExec({ ok: true, result: { screen: SECRET } });
assert.deepEqual(await tool(f.exec, "check_coding_task_status").run({}), { ok: true, output: "idle" });
f = fakeExec({ ok: false, error: { code: "timeout" } });
assert.deepEqual(await tool(f.exec, "check_coding_task_status").run({}), { ok: true, output: "working" });
assert.ok(f.calls.filter((c) => c[1] === "wait").every((c) => c[3] === "h1"));
const status = (session) => tools(f.exec, session).find((t) => t.name === "check_coding_task_status").run({});
assert.deepEqual(await status("h4"), { ok: true, output: "work session not open" }, "disconnected");
assert.deepEqual(await status("h7"), { ok: true, output: "work session not open" }, "closed");
assert.deepEqual(await status(null), { ok: true, output: "work session not open" }, "none picked");

// start_coding_task: dispatch set up once via a closed mailbox, never --inject; 'sent' at once; reply follows.
f = fakeExec({ ok: true });
let reg = tools(f.exec);
const delegate = reg.find((t) => t.name === "start_coding_task");
assert.equal(delegate.nonBlocking, true);
let r = await delegate.run({ text: "tạo file hello.txt" });
assert.deepEqual({ ok: r.ok, output: r.output }, { ok: true, output: "started" });
assert.deepEqual(await r.followUp, { reply: "Done: hello.txt created." });
const sub = (name) => f.calls.filter((c) => c[1] === name);
assert.ok(sub("run-create")[0].includes("--from") && sub("run-create")[0].includes("mbox"));
assert.ok(!f.calls.some((c) => c.includes("--inject")), "never --inject");
assert.deepEqual(sub("close")[0], ["terminal", "close", "--terminal", "mbox"]);
assert.ok(sub("worker-read").every((c) => c[c.indexOf("--source") + 1] === "transcript"), "transcript source only");
assert.ok(!f.calls.some((c) => c[1] === "read"), "never terminal read");
assert.deepEqual(sub("send")[0], ["terminal", "send", "--terminal", "h1", "--text", "tạo file hello.txt" + VOICE_BRIEF, "--enter", "--wait-submit", "5"]);
await delegate.run({ text: "again" });
assert.equal(sub("dispatch").length, 1, "dispatch cached per session");
assert.equal((await delegate.run({ text: " " })).ok, false);
// Last reply comes from cache.
const reads = sub("worker-read").length;
assert.deepEqual(await reg.find((t) => t.name === "repeat_coding_task_result").run({}), { ok: true, output: "Done: hello.txt created." });
assert.equal(sub("worker-read").length, reads);
assert.match((await reg.find((t) => t.name === "recall_past_coding_tasks").run({})).output, /^User: old prompt/);
assert.equal(sub("worker-read").at(-1).at(-1), "200", "history reads 200 messages");
assert.ok(sub("worker-read").slice(0, -1).every((c) => c.at(-1) === "40"), "replies read 40");

// An active dispatch left by an earlier app session is reused, no new Run.
const reuse = fakeExec({ ok: true });
const base = reuse.exec;
reuse.exec = async (a) => (a[1] === "worker-list" ? { json: { ok: true, result: { workers: [{ dispatchId: "ctx_prev", terminal: "h1", outcome: "in_progress" }] } } } : base(a));
await tool(reuse.exec, "repeat_coding_task_result").run({});
assert.ok(!reuse.calls.some((c) => c[1] === "run-create"));
assert.ok(reuse.calls.find((c) => c[1] === "worker-read").includes("ctx_prev"));

// Last reply with no cache: retries session_not_reported, then reads.
const notReported = { ok: false, error: { code: "transcript_required", data: { reason: "session_not_reported" } } };
f = fakeExec({ ok: true }, [notReported, transcript]);
assert.deepEqual(await tool(f.exec, "repeat_coding_task_result").run({}), { ok: true, output: "Done: hello.txt created." });
assert.equal(f.calls.filter((c) => c[1] === "worker-read").length, 2);

// Steer only interrupts when busy; stop sends Escape.
f = fakeExec({ ok: true });
await tool(f.exec, "steer_coding_task").run({ text: "x", interrupt: true });
assert.ok(!f.calls.at(-1).includes("--interrupt"), "idle: no --interrupt");
f = fakeExec({ ok: false, error: { code: "timeout" } });
await tool(f.exec, "steer_coding_task").run({ text: "x", interrupt: true });
assert.ok(f.calls.at(-1).includes("--interrupt"), "busy: --interrupt");
await tool(f.exec, "stop_coding_task").run({});
assert.deepEqual(f.calls.at(-1), ["terminal", "send", "--terminal", "h1", "--text", "\x1b"]);

// Clear sends /clear and forgets the cached reply.
f = fakeExec({ ok: true }, [transcript, { ok: true, result: { transcript: { messages: [{ role: "user", blocks: [{ type: "text", text: "/clear" }] }] } } }]);
reg = tools(f.exec);
await reg.find((t) => t.name === "start_coding_task").run({ text: "x" }).then((x) => x.followUp);
assert.deepEqual(await reg.find((t) => t.name === "clear_coding_memory").run({}), { ok: true, output: "sent" });
assert.deepEqual(f.calls.filter((c) => c[1] === "send").at(-1), ["terminal", "send", "--terminal", "h1", "--text", "/clear", "--enter", "--wait-submit", "5"]);
assert.deepEqual(await reg.find((t) => t.name === "repeat_coding_task_result").run({}), { ok: true, output: "(no result yet)" });

// Session list: live Claude terminals (status glyph stripped), then named sessions not running, newest per title.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "iris-sessions-"));
const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"];
const named = (id, title, cwd, mtime) => {
  fs.mkdirSync(path.join(root, "-p", id), { recursive: true });
  if (title) fs.writeFileSync(path.join(root, "-p", id, "custom-title.json"), JSON.stringify({ customTitle: title }));
  const file = path.join(root, "-p", `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: "custom-title", customTitle: title }) + "\n" + JSON.stringify({ cwd, message: SECRET }) + "\n");
  fs.utimesSync(file, mtime, mtime);
};
named(ids[0], "voice", "/w/a", 1);
named(ids[1], "old", "/w/b", 1);
named(ids[2], "old", "/w/b \"x\"", 2);
named(ids[3], null, "/w/d", 3);
terminals = [...terminals, { title: "old", handle: "h5", connected: true, writable: true, worktreePath: "/w/b" }];
f = fakeExec({ ok: true });
assert.deepEqual(await listSessions(f.exec, root), [
  { title: "voice", handle: "h1", cwd: "/w/a", running: true },
  { title: "old", handle: "h5", cwd: "/w/b", running: true },
]);
terminals = terminals.slice(0, 3);
assert.deepEqual((await listSessions(f.exec, root)).at(-1), { title: "old", id: ids[2], cwd: "/w/b \"x\"", running: false });
assert.equal(await openSession(ids[2], f.exec, root), "mbox");
assert.deepEqual(f.calls.at(-1), ["terminal", "create", "--worktree", "path:/w/b \"x\"", "--title", "old", "--command", `claude --resume ${ids[2]}`, "--focus"]);
await assert.rejects(openSession("x; rm -rf /", f.exec, root), /unknown session/);
fs.rmSync(root, { recursive: true });

// Tool-call cancellation: which responses go out.
const S1 = {}, S2 = {};
let cancelled = new Set(["b"]);
assert.deepEqual(responsesToSend([{ id: "a" }, { id: "b" }], cancelled, S1, S1), [{ id: "a" }], "cancelled blocking call not sent");
assert.equal(cancelled.size, 0);
cancelled = new Set(["n"]);
assert.deepEqual(responsesToSend([{ id: "n", willContinue: true }], cancelled, S1, S1), [], "cancelled non-blocking: no first response");
assert.equal(followUpToSend("n", cancelled, S1, S1), false, "cancelled non-blocking: no follow-up");
assert.equal(cancelled.size, 0);
assert.equal(followUpToSend("m", new Set(), S1, S1), true);
assert.equal(followUpToSend("m", new Set(), S1, S2), false, "follow-up after the session changed");
assert.deepEqual(responsesToSend([{ id: "a" }], new Set(), S1, S2), [], "response after the session changed");

// A throwing exec becomes { ok:false }.
assert.equal((await tool(async () => { throw new Error("boom"); }, "stop_coding_task").run({})).ok, false);
// Busy: refused, nothing sent.
f = fakeExec({ ok: false, error: { code: "timeout" } });
r = await tool(f.exec, "start_coding_task").run({ text: "x" });
assert.equal(r.ok, false);
assert.ok(!f.calls.some((c) => c[1] === "send"), "busy: no prompt queued");
// Idle fires before the new prompt is answered: keep waiting for the reply.
const unanswered = { ok: true, result: { transcript: { messages: [{ role: "user", blocks: [{ type: "text", text: "tạo file hello.txt" }] }] } } };
f = fakeExec({ ok: true }, [unanswered, transcript]);
r = await tool(f.exec, "start_coding_task").run({ text: "tạo file hello.txt" });
assert.deepEqual(await r.followUp, { reply: "Done: hello.txt created." });
console.log("tools selftest ok");
