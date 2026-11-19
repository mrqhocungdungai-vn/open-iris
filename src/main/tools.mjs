// Gemini Live tools that drive Orca CLI terminals. Claude Code does the work; these tools only
// steer it and read back its reply. Privacy rule: nothing from a terminal screen, preview or
// other terminals ever reaches Gemini, only states, Claude's own assistant text and (recall_past_coding_tasks)
// the user's own prompts.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One switch per tool, app tools first (they are the default way to act). The app tools (desktop.mjs) are on by default although they act on screen (user, 2026-11-19).
export const TOOL_DEFAULTS = {
  list_running_apps: true, open_or_focus_app: true, scan_app_controls: true, find_app_control: true, read_app_text: true,
  click_app_control: true, pick_list_option: true, type_into_text_field: true, press_key_combo: true,
  check_coding_task_status: true, repeat_coding_task_result: true, recall_past_coding_tasks: true,
  start_coding_task: false, steer_coding_task: false, stop_coding_task: false, clear_coding_memory: false,
};
// Names before 2026-11-19, so a saved config keeps its choices.
const RENAMED = { task_status: "check_coding_task_status", task_result: "repeat_coding_task_result", task_history: "recall_past_coding_tasks", do_task: "start_coding_task", task_steer: "steer_coding_task", task_stop: "stop_coding_task", task_clear: "clear_coding_memory" };
export const REPLY_MAX = 8000;
// Orca clips transcript text at ~1200 chars, and long answers are bad speech anyway: ask for a brief.
export const VOICE_BRIEF = "\n\n(This answer is read aloud. Under 150 words, plain spoken sentences, no tables, code, links or markdown. Lead with the answer, then name the main parts in one short line each; keep the details for follow-up questions.)";

// Markup is noise for speech: drop code blocks, table rules, URLs and markdown characters.
export const toSpeech = (s) => s
  .replace(/```[\s\S]*?```/g, "(code omitted)")
  .replace(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|?[ \t]*$/gm, "")
  .replace(/^[ \t]*\|[ \t]*(.*?)[ \t]*\|[ \t]*$/gm, "$1")
  .replace(/[ \t]*\|[ \t]*/g, ", ")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/https?:\/\/\S+/g, "")
  .replace(/^[ \t]*(#+|>)[ \t]*/gm, "")
  .replace(/\*\*|__|`/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// Trust boundary (config file / IPC): unknown names are dropped, values coerced to booleans.
export function cleanTools(t) {
  t = t && Object.fromEntries(Object.entries(t).map(([k, v]) => [RENAMED[k] ?? k, v]));
  return Object.fromEntries(Object.keys(TOOL_DEFAULTS).map((k) => [k, t && k in t ? Boolean(t[k]) : TOOL_DEFAULTS[k]]));
}

// Orchestration commands bind their Run/mail to the caller's terminal; strip it so a launch from
// an Orca terminal does not make that terminal (e.g. the user's Claude session) the mail target.
const env = { ...process.env };
delete env.ORCA_TERMINAL_HANDLE;
delete env.ORCA_PANE_KEY;
// `orca` lives inside Orca.app; a shell outside Orca (or Finder) may not have it on PATH, so fall back to the default install.
// `claude` installs to ~/.local/bin or Homebrew, also missing from a Finder-launched app's PATH.
env.PATH = `${env.PATH || ""}:/Applications/Orca.app/Contents/Resources/bin:${os.homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin`;
// The Claude Code feature needs both CLIs: true when `<name> --version` runs.
export const hasCli = (name) => new Promise((resolve) => execFile(name, ["--version"], { timeout: 5000, env }, (err) => resolve(!err)));
export function orcaExec(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile("orca", [...args, "--json"], { timeout, env }, (err, stdout) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* non-JSON output */ }
      resolve({ err, json });
    });
  });
}

// Final assistant text of the latest turn: the last assistant message with text after the last
// user prompt. Tool calls/results are separate messages/blocks and are dropped.
// Claude Code stores command output as user text in tags (<bash-stdout>, <local-command-stdout>,
// <system-reminder>, …): such text is never a prompt and must never reach Gemini.
const textOf = (m) => (Array.isArray(m.blocks) ? m.blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim() : "");
const isPrompt = (m) => m.role === "user" && !textOf(m).startsWith("<");

export function extractReply(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const start = list.findLastIndex(isPrompt) + 1;
  const texts = (m) => (m.role === "assistant" && Array.isArray(m.blocks) ? m.blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text) : []);
  const last = list.slice(start).findLast((m) => texts(m).join("").trim());
  return last ? toSpeech(texts(last).join("\n")).slice(0, REPLY_MAX) : "";
}

// Recent turns as "User: … / Claude: …", one final assistant text per turn, for catching up on a resumed session.
export function extractHistory(messages, turns = 5) {
  const list = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = textOf(m);
    if (!t) continue; // tool calls/results carry no text blocks
    if (isPrompt(m)) list.push({ user: t.replace(VOICE_BRIEF, ""), reply: "" });
    else if (m.role === "assistant") {
      // A long agentic turn can push its prompt out of the read window.
      if (!list.length) list.push({ user: "(earlier request)", reply: "" });
      list.at(-1).reply = t;
    }
  }
  return list.slice(-turns).map((x) => `User: ${x.user}\nClaude: ${toSpeech(x.reply) || "(no text reply)"}`).join("\n\n").slice(-REPLY_MAX);
}

// Gemini Live tool-call bookkeeping (main.mjs), pure so it can be tested. `cancelled` holds ids from
// toolCallCancellation; s is the session the calls came from, current the session now.
// A NON_BLOCKING id (willContinue) stays in `cancelled` until its follow-up sees it.
export function responsesToSend(responses, cancelled, s, current) {
  const live = responses.filter((f) => (f.willContinue ? !cancelled.has(f.id) : !cancelled.delete(f.id)));
  return s === current ? live : [];
}
export const followUpToSend = (id, cancelled, s, current) => !cancelled.delete(id) && s === current;

// The session picked in the UI, checked on every call: its terminal must still be live.
async function resolveSession(handle, exec) {
  const { json } = await exec(["terminal", "list"]);
  const list = json?.result?.terminals;
  if (!Array.isArray(list)) return { error: "orca terminal list failed" };
  return list.some((t) => t.handle === handle && t.connected && t.writable) ? { handle } : { notFound: true };
}

// Claude Code sessions named with /rename: projects/<dir>/<id>/custom-title.json beside <id>.jsonl.
// Only titles, ids and folders are read here; nothing of this list goes to Gemini.
const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function namedSessions(root) {
  const byTitle = new Map(); // after /clear several sessions share a title: keep the newest
  for (const dir of fs.readdirSync(root)) {
    let ids;
    try { ids = fs.readdirSync(path.join(root, dir)).filter((id) => UUID.test(id)); } catch { continue; }
    for (const id of ids) {
      try {
        const title = JSON.parse(fs.readFileSync(path.join(root, dir, id, "custom-title.json"), "utf8")).customTitle;
        const file = path.join(root, dir, `${id}.jsonl`);
        const fd = fs.openSync(file, "r");
        const head = Buffer.alloc(65536);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        const cwd = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head.toString("utf8", 0, n))?.[1];
        const time = fs.statSync(file).mtimeMs;
        if (typeof title !== "string" || !title || !cwd) continue;
        if ((byTitle.get(title)?.time ?? -1) < time) byTitle.set(title, { title, id, cwd: JSON.parse(cwd), time });
      } catch { /* not a named session */ }
    }
  }
  return [...byTitle.values()].sort((a, b) => b.time - a.time);
}

// Live Claude Code terminals first, then named sessions that are not running.
export async function listSessions(exec = orcaExec, root = PROJECTS) {
  const { err, json } = await exec(["terminal", "list"]);
  const list = json?.result?.terminals;
  // The reason (timeout, ENOENT = orca not on PATH, Orca's own error code) shows in the log and the conversation box.
  if (!Array.isArray(list)) throw new Error(`orca terminal list failed: ${json?.error?.code || json?.error?.message || err?.code || err?.signal || err?.message || "no JSON"}`);
  // Claude Code prefixes the tab title with a status glyph (e.g. "✳ ") while working.
  const plain = (t) => String(t.title || "").replace(/^[^\p{L}\p{N}]+/u, "");
  const named = namedSessions(root);
  // Orphaned terminals lose agentIdentity; a matching title still means the session is running.
  const namedTitles = new Set(named.map((s) => s.title));
  const live = list.filter((t) => t.connected && t.writable && (t.agentIdentity === "claude" || namedTitles.has(plain(t))))
    .map((t) => ({ title: plain(t) || "Claude Code", handle: t.handle, cwd: t.worktreePath, running: true }));
  const titles = new Set(live.map((s) => s.title));
  return [...live, ...named.filter((s) => !titles.has(s.title)).map(({ title, id, cwd }) => ({ title, id, cwd, running: false }))];
}

// Resume a named session in a new Orca terminal; returns its handle. The id comes from the renderer: look it up again.
export async function openSession(id, exec = orcaExec, root = PROJECTS) {
  const s = namedSessions(root).find((x) => x.id === id);
  if (!s) throw new Error("unknown session");
  const { json } = await exec(["terminal", "create", "--worktree", `path:${s.cwd}`, "--title", s.title, "--command", `claude --resume ${s.id}`, "--focus"]);
  const handle = json?.result?.terminal?.handle;
  if (!handle) throw new Error(`open session: ${json?.error?.code || json?.error?.message || "failed"}`);
  return handle;
}

// tui-idle with a 1 ms timeout: satisfied => idle, timeout => working. Reads no screen content.
async function stateOf(handle, exec) {
  const { json } = await exec(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "1"]);
  if (json?.ok) return "idle";
  if (json?.error?.code === "timeout") return "working";
  return null;
}

async function sendText(handle, text, extra, exec) {
  const { json } = await exec(["terminal", "send", "--terminal", handle, "--text", text, ...extra]);
  return json?.ok ? { ok: true, output: "sent" } : { ok: false, error: json?.error?.code || "orca send failed" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function registry(exec = orcaExec, session = null) {
  const dispatches = new Map(); // handle -> Promise<dispatch id>, once per app session
  let lastReply = "";

  // A' setup: Run + Task + Dispatch WITHOUT --inject, so nothing is typed into the agent.
  // Orca mails "worker stopped without reporting" to the creator, so a throwaway mailbox
  // terminal (`cat > /dev/null`) is the creator and is closed right after; mail to it is harmless.
  async function setupDispatch(handle) {
    const ok = (r, what) => {
      if (!r.json?.ok) throw new Error(`${what}: ${r.json?.error?.code || "failed"}`);
      return r.json.result;
    };
    // Orca allows one active dispatch per terminal and keeps it across app restarts: reuse it.
    // shortcut: only the newest 100 dispatches are scanned; page with nextCursor if dispatch then fails with "already has an active dispatch".
    const workers = ok(await exec(["orchestration", "worker-list", "--limit", "100"]), "worker-list").workers;
    const active = workers?.find((w) => w.terminal === handle && w.outcome === "in_progress");
    if (active) return active.dispatchId;
    const mailbox = ok(await exec(["terminal", "create", "--title", "open-iris-mailbox", "--command", "cat > /dev/null"]), "mailbox").terminal.handle;
    try {
      const from = ["--from", mailbox];
      const { runId } = ok(await exec(["orchestration", "run-create", ...from, "--objective", "open-iris voice readout"]), "run-create");
      const { taskId } = ok(await exec(["orchestration", "task-create", ...from, "--run", runId, "--task-title", "open-iris voice", "--spec", "open-iris reads replies back by voice"]), "task-create");
      return ok(await exec(["orchestration", "dispatch", ...from, "--run", runId, "--task", taskId, "--to", handle]), "dispatch").dispatch.id;
    } finally {
      await exec(["terminal", "close", "--terminal", mailbox]);
    }
  }
  function dispatchFor(handle) {
    if (!dispatches.has(handle)) dispatches.set(handle, setupDispatch(handle).catch((e) => (dispatches.delete(handle), Promise.reject(e))));
    return dispatches.get(handle);
  }

  // Transcript only: --source auto/terminal can fall back to screen rows, which must never reach Gemini.
  // Without --cursor, --limit returns the latest messages.
  async function readMessages(handle, limit = 40, tries = 5) {
    const id = await dispatchFor(handle);
    for (let i = 1; ; i++) {
      const { json } = await exec(["orchestration", "worker-read", "--dispatch", id, "--source", "transcript", "--limit", String(limit)]);
      if (json?.ok) return json.result?.transcript?.messages;
      // The session is reported by Orca's hook only after a prompt runs; retry briefly.
      if (json?.error?.data?.reason !== "session_not_reported" || i >= tries) throw new Error(`worker-read: ${json?.error?.code || "failed"}`);
      await sleep(1000);
    }
  }
  const readReply = async (handle) => extractReply(await readMessages(handle));

  // Waits for the turn to end (up to ~30 min), then caches and returns the reply.
  async function replyWhenIdle(handle) {
    for (let timeouts = 0, empty = 0; timeouts < 6; ) {
      const { json } = await exec(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "300000"], 310000);
      if (json?.ok) {
        const reply = await readReply(handle);
        // tui-idle can fire before Claude starts or before the transcript is written: an unanswered prompt is not done yet.
        if (!reply && ++empty < 5) { await sleep(2000); continue; }
        lastReply = reply || "(no text reply)";
        return { reply: lastReply };
      }
      if (json?.error?.code !== "timeout") return { error: `wait: ${json?.error?.code || "failed"}` };
      timeouts++;
    }
    return { error: "still working after 30 min" };
  }

  const text = { type: "string", description: "One clear, self-contained prompt, rewritten from the user's words." };
  // Every run() resolves (never throws) and returns { ok, output } or { ok:false, error }.
  // start_coding_task also returns followUp: a Promise of { reply } or { error } for the NON_BLOCKING response.
  const guard = (fn) => async (args) => {
    try { return await fn(args); } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
  };
  const withSession = (fn) => guard(async (args) => {
    const r = session ? await resolveSession(session, exec) : { notFound: true };
    if (r.error) return { ok: false, error: r.error };
    if (r.notFound) return { ok: true, output: "work session not open" };
    return fn(r.handle, args);
  });
  const needText = (args) => typeof args?.text === "string" && args.text.trim();
  const none = { type: "object", properties: {} };
  return [
    {
      name: "check_coding_task_status",
      description: "Check whether you are still working on a task: working, idle or work session not open. Call when the user asks if a task is done, finished or still running.",
      parameters: none,
      run: withSession(async (h) => {
        const s = await stateOf(h, exec);
        return s ? { ok: true, output: s } : { ok: false, error: "status unavailable" };
      }),
    },
    {
      name: "repeat_coding_task_result",
      description: `Get the full result of your last task (max ${REPLY_MAX} chars). Call only when the user asks to hear it again.`,
      parameters: none,
      run: withSession(async (h) => ({ ok: true, output: lastReply || (await readReply(h)) || "(no result yet)" })),
    },
    {
      name: "recall_past_coding_tasks",
      description: "Recall your last few exchanges with the user (their request and your answer), to tell where earlier work left off. Call when the user asks what was done before. Not for whether a task is done yet: that is check_coding_task_status.",
      parameters: none,
      run: withSession(async (h) => ({ ok: true, output: extractHistory(await readMessages(h, 200)) || "(no history yet)" })),
    },
    {
      name: "start_coding_task",
      nonBlocking: true,
      description: "Do programming work yourself: write or fix code, work in a repository or the terminal. Not for using apps or the web. Returns 'started' at once; the result arrives later as this call's result.",
      parameters: { type: "object", properties: { text }, required: ["text"] },
      run: withSession(async (h, a) => {
        if (!needText(a)) return { ok: false, error: "empty text" };
        // A second prompt would queue behind the first and its reply would be read for both.
        if ((await stateOf(h, exec)) === "working") return { ok: false, error: "still working on the previous task: wait for its result, or use steer_coding_task to change it" };
        await dispatchFor(h);
        const sent = await sendText(h, a.text + VOICE_BRIEF, ["--enter", "--wait-submit", "5"], exec);
        if (!sent.ok) return sent;
        return { ok: true, output: "started", followUp: replyWhenIdle(h).catch((e) => ({ error: String(e?.message || e).slice(0, 200) })) };
      }),
    },
    {
      name: "steer_coding_task",
      description: "Add guidance to the task you are working on. Default: applied after the current step. interrupt=true stops the current step and uses this instead.",
      parameters: { type: "object", properties: { text, interrupt: { type: "boolean" } }, required: ["text"] },
      run: withSession(async (h, a) => {
        if (!needText(a)) return { ok: false, error: "empty text" };
        // --interrupt while idle leaves an unsubmitted draft, so only use it when busy.
        const busy = a.interrupt === true && (await stateOf(h, exec)) === "working";
        return sendText(h, a.text, busy ? ["--enter", "--interrupt"] : ["--enter"], exec);
      }),
    },
    {
      name: "stop_coding_task",
      description: "Stop the task you are working on. Only after the user said yes.",
      parameters: none,
      run: withSession((h) => sendText(h, "\x1b", [], exec)),
    },
    {
      name: "clear_coding_memory",
      description: "Start fresh: forget everything from earlier tasks so old context does not get in the way. Only after the user said yes.",
      parameters: none,
      run: withSession(async (h) => {
        lastReply = "";
        return sendText(h, "/clear", ["--enter", "--wait-submit", "5"], exec);
      }),
    },
  ];
}
