// Plugin hooks (docs/plugin-hooks-spec.md, plugin API 1). Wired into main.mjs through createHooks().
// ~/.open-iris/plugins/<name>/
//   .open-iris-plugin/plugin.json  { name, version, open_iris_api, description, fields, components: { hooks: "./hooks/hooks.json" } }
//   hooks/hooks.json               { hooks: { <Event>: [{ name, label, label_en, matcher?, every_min?, hooks: [{ type, text|command, timeout? }] }] } }
//   tools/tools.json               { tools: [{ name, label, label_en, description, parameters, brief?, command, timeout?, late?, confirm? }] } (spec §12)
// The core knows no plugin by name: fields and group names are whatever the plugin declares.
// User values (field text, switches, periods) live in config.json → plugins; trust approvals in trust.json.
import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PLUGIN_API = 1;
export const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FIELD_KEY = /^[a-z][a-z0-9_]{0,31}$/;
export const FIELDS_MAX = 5, GROUPS_MAX = 20, HOOKS_MAX = 5;
export const TEXT_MAX = 1000, FIELD_MAX = 1000, LABEL_MAX = 80, MATCHER_MAX = 200;
export const SESSION_CONTEXT_MAX = 4000; // all SessionStart context together; it sits in the system instruction for the whole session
export const EVERY_MIN = 2, EVERY_MAX = 60;
export const QUIET_MS = 4000, GAP_MS = 60_000;
export const SESSION_START_MAX_MS = 15_000; // all SessionStart command hooks together: the session waits for them before it connects
export const TIMEOUT_S = 3, TIMEOUT_MAX_S = 10, TICK_TIMEOUT_MAX_S = 30;
export const OUT_MAX = 64 * 1024;
export const COMPONENTS = ["hooks", "tools"];
// Command tools (spec §12). shortcut: own cap, not shared with composed tools (pack-plan §4); revisit if a plugin needs both.
export const TOOL_NAME = /^[a-z0-9_]{1,40}$/, PARAM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const TOOLS_MAX = 8, PARAMS_MAX = 10, BRIEF_MAX = 300, TOOL_TIMEOUT_S = 10, TOOL_TIMEOUT_MAX_S = 30, LATE_MAX_MIN = 30;
export const TOOL_OUT_MAX = 8000, ARG_MAX = 4000, LATE_RUNNING_MAX = 2;

// Spec §4: where each hook type may be used. Only PreToolCall can block.
export const EVENTS = ["SessionStart", "SessionEnd", "UserTurn", "IrisTurn", "PreToolCall", "PostToolCall", "ListenOnlyChanged", "Tick"];
const CONTEXT_EVENTS = new Set(["SessionStart", "UserTurn", "IrisTurn", "PreToolCall", "PostToolCall", "ListenOnlyChanged"]);
const SPEAK_EVENTS = new Set(["UserTurn", "IrisTurn", "Tick"]);
const TOOL_EVENTS = new Set(["PreToolCall", "PostToolCall"]);
// Context from these goes to Gemini as sendClientContent(turnComplete:false); the others return it to the caller.
const SIDE_CONTEXT_EVENTS = new Set(["UserTurn", "IrisTurn", "ListenOnlyChanged"]);

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const keysIn = (text) => [...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// "./hooks/hooks.json" only: relative, inside the folder. Symlinks are checked on disk by loadPlugin.
function componentPath(key, rel) {
  if (typeof rel !== "string" || !rel.startsWith("./") || rel.includes("\\") || rel.split("/").includes("..")) {
    throw new Error(`components.${key} must be a path inside the plugin folder starting with ./`);
  }
  return rel;
}

function parseHook(h, event, where, checkKeys) {
  if (!h || typeof h !== "object") throw new Error(`${where}: a hook must be an object`);
  if (h.type === "context" || h.type === "speak") {
    const allowed = h.type === "context" ? CONTEXT_EVENTS : SPEAK_EVENTS;
    if (!allowed.has(event)) throw new Error(`${where}: ${h.type} hooks cannot be used on ${event}`);
    if (typeof h.text !== "string" || !h.text.trim() || h.text.length > TEXT_MAX) throw new Error(`${where}: text must be at most ${TEXT_MAX} characters`);
    checkKeys(h.text, where);
    return { type: h.type, text: h.text };
  }
  if (h.type === "command") {
    if (typeof h.command !== "string" || !h.command.trim() || h.command.length > TEXT_MAX) throw new Error(`${where}: command must be at most ${TEXT_MAX} characters`);
    const max = event === "Tick" ? TICK_TIMEOUT_MAX_S : TIMEOUT_MAX_S;
    const timeout = h.timeout ?? TIMEOUT_S;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > max) throw new Error(`${where}: timeout must be a whole number of seconds from 1 to ${max}`);
    return { type: "command", command: h.command, timeout };
  }
  throw new Error(`${where}: type must be context, speak or command`);
}

// tools.json parameters → the Gemini schema subset: object of string (enum ok) / boolean / number. Rebuilt, so no unknown key reaches Gemini.
function parseParameters(x, where) {
  if (!x || x.type !== "object" || !x.properties || typeof x.properties !== "object" || Array.isArray(x.properties)) throw new Error(`${where}: parameters must be { type: "object", properties }`);
  for (const k of Object.keys(x)) if (!["type", "properties", "required"].includes(k)) throw new Error(`${where}: parameters.${k} is not supported`);
  const keys = Object.keys(x.properties);
  if (keys.length > PARAMS_MAX) throw new Error(`${where}: at most ${PARAMS_MAX} parameters`);
  const properties = {};
  for (const k of keys) {
    const v = x.properties[k];
    if (!PARAM_KEY.test(k) || k === "confirmed") throw new Error(`${where}: parameter "${k}" is invalid or reserved`);
    if (!["string", "boolean", "number"].includes(v?.type)) throw new Error(`${where}: parameter ${k} must be string, boolean or number`);
    for (const f of Object.keys(v)) if (!["type", "description", "enum"].includes(f)) throw new Error(`${where}: parameter ${k}.${f} is not supported`);
    if (v.enum !== undefined && (v.type !== "string" || !Array.isArray(v.enum) || !v.enum.length || !v.enum.every((e) => typeof e === "string"))) throw new Error(`${where}: parameter ${k}.enum must be a list of strings`);
    properties[k] = { type: v.type, ...(typeof v.description === "string" && { description: v.description.slice(0, 300) }), ...(v.enum && { enum: v.enum }) };
  }
  const required = x.required ?? [];
  if (!Array.isArray(required) || !required.every((r) => keys.includes(r))) throw new Error(`${where}: required must list declared parameters`);
  return { type: "object", properties, ...(required.length && { required }) };
}

function parseTools(plugin, doc, file) {
  const list = doc?.tools;
  if (!Array.isArray(list)) throw new Error(`${file}: "tools" must be a list`);
  if (list.length > TOOLS_MAX) throw new Error(`at most ${TOOLS_MAX} command tools per plugin`);
  const names = new Set();
  return list.map((t) => {
    if (!TOOL_NAME.test(t?.name ?? "") || names.has(t.name)) throw new Error(`tool name "${t?.name}" is invalid or repeated`);
    names.add(t.name);
    const where = `tool ${t.name}`, id = `${plugin}__${t.name}`;
    if (id.length > 64) throw new Error(`${where}: ${id} is longer than 64 characters`);
    if (typeof t.description !== "string" || !t.description.trim() || t.description.length > TEXT_MAX) throw new Error(`${where}: description must be at most ${TEXT_MAX} characters`);
    if (t.brief !== undefined && (typeof t.brief !== "string" || t.brief.length > BRIEF_MAX)) throw new Error(`${where}: brief must be at most ${BRIEF_MAX} characters`);
    if (typeof t.command !== "string" || !t.command.trim() || t.command.length > TEXT_MAX) throw new Error(`${where}: command must be at most ${TEXT_MAX} characters`);
    const timeout = t.timeout ?? TOOL_TIMEOUT_S;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > TOOL_TIMEOUT_MAX_S) throw new Error(`${where}: timeout must be a whole number of seconds from 1 to ${TOOL_TIMEOUT_MAX_S}`);
    const m = t.late?.timeout_min;
    if (t.late !== undefined && (!Number.isInteger(m) || m < 1 || m > LATE_MAX_MIN)) throw new Error(`${where}: late.timeout_min must be a whole number of minutes from 1 to ${LATE_MAX_MIN}`);
    if (t.confirm !== undefined && typeof t.confirm !== "boolean") throw new Error(`${where}: confirm must be true or false`);
    return {
      id, name: t.name, label: str(t.label, LABEL_MAX) || t.name, label_en: str(t.label_en, LABEL_MAX),
      description: t.description, parameters: parseParameters(t.parameters, where), brief: t.brief?.trim() ?? "",
      command: t.command, timeout, ...(t.late && { late: { timeout_min: m } }), confirm: t.confirm === true,
    };
  });
}

// One plugin → { name, version, api, description, fields, groups, tools, hasCommand } or throws with the reason.
// read(rel) returns the parsed JSON of a component file; the path has already passed componentPath().
export function parsePlugin(dirName, meta, read) {
  if (!meta || typeof meta !== "object") throw new Error("plugin.json is not an object");
  if (meta.name !== dirName || !NAME.test(dirName)) throw new Error(`name must match the folder and ${NAME}`);
  if (!Number.isInteger(meta.open_iris_api) || meta.open_iris_api < 1) throw new Error("open_iris_api must be a whole number");
  if (meta.open_iris_api > PLUGIN_API) throw new Error(`needs a newer open-iris (plugin API ${meta.open_iris_api}, this app has ${PLUGIN_API})`);

  const fields = meta.fields ?? [];
  if (!Array.isArray(fields) || fields.length > FIELDS_MAX) throw new Error(`fields must be a list of at most ${FIELDS_MAX}`);
  const keys = new Set();
  const cleanFields = fields.map((f) => {
    if (!FIELD_KEY.test(f?.key ?? "") || keys.has(f.key)) throw new Error(`field key "${f?.key}" is invalid or repeated`);
    keys.add(f.key);
    const max = Number.isInteger(f.max) && f.max > 0 ? Math.min(f.max, FIELD_MAX) : 200;
    return { key: f.key, label: str(f.label, LABEL_MAX) || f.key, label_en: str(f.label_en, LABEL_MAX), hint: str(f.hint, 200), max };
  });
  const checkKeys = (text, where) => {
    for (const k of keysIn(text)) if (!keys.has(k)) throw new Error(`${where} uses {${k}}, which is not a field`);
  };

  const components = meta.components ?? {};
  if (!components || typeof components !== "object" || Array.isArray(components)) throw new Error("components must be an object");
  for (const key of Object.keys(components)) if (!COMPONENTS.includes(key)) throw new Error(`components.${key} is not supported (known: ${COMPONENTS.join(", ")})`);

  const groups = [];
  if (components.hooks !== undefined) {
    const file = componentPath("hooks", components.hooks);
    const doc = read(file);
    const byEvent = doc?.hooks;
    if (!byEvent || typeof byEvent !== "object" || Array.isArray(byEvent)) throw new Error(`${file}: "hooks" must be an object of events`);
    const names = new Set();
    for (const [event, list] of Object.entries(byEvent)) {
      if (!EVENTS.includes(event)) throw new Error(`${file}: unknown event ${event}`);
      if (!Array.isArray(list)) throw new Error(`${file}: ${event} must be a list of groups`);
      for (const g of list) {
        if (!NAME.test(g?.name ?? "") || names.has(g.name)) throw new Error(`${event}: group name "${g?.name}" is invalid or repeated`);
        names.add(g.name);
        const where = `group ${g.name}`;
        let matcher;
        if (g.matcher !== undefined) {
          if (!TOOL_EVENTS.has(event)) throw new Error(`${where}: matcher is only for PreToolCall and PostToolCall`);
          if (typeof g.matcher !== "string" || g.matcher.length > MATCHER_MAX) throw new Error(`${where}: matcher must be a regex of at most ${MATCHER_MAX} characters`);
          try { new RegExp(g.matcher); } catch { throw new Error(`${where}: matcher is not a valid regex`); }
          matcher = g.matcher;
        }
        if (event === "Tick") {
          if (!Number.isInteger(g.every_min) || g.every_min < EVERY_MIN || g.every_min > EVERY_MAX) throw new Error(`${where}: every_min must be a whole number from ${EVERY_MIN} to ${EVERY_MAX}`);
        } else if (g.every_min !== undefined) throw new Error(`${where}: every_min is only for Tick`);
        if (!Array.isArray(g.hooks) || !g.hooks.length || g.hooks.length > HOOKS_MAX) throw new Error(`${where}: hooks must be a list of 1 to ${HOOKS_MAX}`);
        groups.push({
          id: `${dirName}/${g.name}`, name: g.name, event,
          label: str(g.label, LABEL_MAX) || g.name, label_en: str(g.label_en, LABEL_MAX),
          ...(matcher !== undefined && { matcher }), ...(event === "Tick" && { every_min: g.every_min }),
          hooks: g.hooks.map((h, i) => parseHook(h, event, `${where} hook ${i + 1}`, checkKeys)),
        });
      }
    }
    if (groups.length > GROUPS_MAX) throw new Error(`at most ${GROUPS_MAX} hook groups per plugin`);
  }
  const tools = components.tools === undefined ? [] : parseTools(dirName, read(componentPath("tools", components.tools)), components.tools);

  return {
    name: dirName, version: str(meta.version, 32), api: meta.open_iris_api, description: str(meta.description, 300),
    fields: cleanFields, groups, tools, hasCommand: tools.length > 0 || groups.some((g) => g.hooks.some((h) => h.type === "command")),
  };
}

// One plugin folder from disk. Component files and every symlink must resolve inside the folder.
export function loadPlugin(dir) {
  const root = fs.realpathSync(dir);
  walkPlugin(root, () => {});
  const meta = readJson(path.join(root, ".open-iris-plugin", "plugin.json"));
  const read = (rel) => {
    let real;
    try { real = fs.realpathSync(path.join(root, rel)); } catch { throw new Error(`${rel} is missing`); }
    if (!real.startsWith(root + path.sep)) throw new Error(`${rel} points outside the plugin folder`);
    return readJson(real);
  };
  return { ...parsePlugin(path.basename(dir), meta, read), dir: root };
}

// Every folder in <home>/plugins, sorted by name. Dot-folders (e.g. a half-copied .<name>.adding) are skipped. A broken plugin comes back as { name, error } so the tab can show why.
export function loadPlugins(home, warn = () => {}) {
  const root = path.join(home, "plugins");
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort(); } catch { return []; }
  return dirs.map((name) => {
    try {
      return loadPlugin(path.join(root, name));
    } catch (e) {
      warn(`plugin ${name}: ${e.message}`);
      return { name, error: e.message };
    }
  });
}

// config.json → plugins: { [name]: { on, fields: {key: text}, groups: {[group]: {on, every_min}}, tools: {[tool]: {on}} } }. IPC/file trust boundary.
const oneLine = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
export function cleanPluginConfig(c) {
  const out = {};
  for (const [name, p] of Object.entries(c && typeof c === "object" ? c : {})) {
    if (!NAME.test(name) || !p || typeof p !== "object") continue;
    const fields = Object.fromEntries(Object.entries(p.fields && typeof p.fields === "object" ? p.fields : {})
      .filter(([k]) => FIELD_KEY.test(k)).map(([k, v]) => [k, oneLine(v, FIELD_MAX)]));
    const groups = Object.fromEntries(Object.entries(p.groups && typeof p.groups === "object" ? p.groups : {})
      .filter(([k, g]) => NAME.test(k) && g && typeof g === "object")
      .map(([k, g]) => [k, { on: g.on === true, ...(Number.isInteger(g.every_min) && { every_min: Math.min(EVERY_MAX, Math.max(EVERY_MIN, g.every_min)) }) }]));
    const tools = Object.fromEntries(Object.entries(p.tools && typeof p.tools === "object" ? p.tools : {})
      .filter(([k, t]) => TOOL_NAME.test(k) && t && typeof t === "object").map(([k, t]) => [k, { on: t.on === true }]));
    out[name] = { on: p.on === true, fields, groups, tools };
  }
  return out;
}

// {key} → value. A sentence whose field is empty is dropped, so Gemini never gets "Goal: .".
export function fill(text, values) {
  return text.split(/(?<=[.!?])\s+/)
    .filter((s) => keysIn(s).every((k) => values[k]))
    .map((s) => s.replace(/\{([a-z][a-z0-9_]*)\}/g, (_, k) => values[k]))
    .join(" ");
}

// Every entry of the plugin folder except folders, in name order: onEntry(rel, full, lstat). .DS_Store is skipped, since
// Finder writes it just by opening the folder. A symlink must resolve inside the folder (spec §6), or this throws: the
// hash covers the link text only, so code it points to outside could change under the same hash.
function walkPlugin(dir, onEntry) {
  const root = fs.realpathSync(dir);
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (name === ".DS_Store") continue;
      const r = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, r);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) { walk(r); continue; }
      if (st.isSymbolicLink()) {
        let real;
        try { real = fs.realpathSync(full); } catch { throw new Error(`${r} is a broken link`); }
        if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`${r} points outside the plugin folder`);
      }
      onEntry(r, full, st);
    }
  };
  walk("");
}

// sha256 over every file in the plugin folder, in name order: path, mode, size, bytes. Symlinks hash their target text.
export function trustHash(dir) {
  const h = crypto.createHash("sha256");
  walkPlugin(dir, (r, full, st) => {
    if (st.isSymbolicLink()) h.update(`link\0${r}\0${fs.readlinkSync(full)}\0`);
    else if (st.isFile()) {
      h.update(`file\0${r}\0${st.mode & 0o777}\0${st.size}\0`);
      h.update(fs.readFileSync(full));
    }
  });
  return h.digest("hex");
}

// → (plugin) → true if its folder still hashes to trust[name]. File bytes are re-read only when a file's path, ctime,
// size, inode or mode changed since the last check (ctime cannot be set back by hand, unlike mtime), so a plugin with a
// big node_modules does not re-read every file on each hook. A folder that cannot be walked falls back to hashOf.
export function trustCheck(trust, hashOf = trustHash) {
  const seen = new Map(); // plugin name → { sig, ok }
  return (p) => {
    try {
      if (typeof trust[p.name] !== "string") return false;
      let sig = "";
      try { walkPlugin(p.dir, (r, _full, st) => { sig += `${r}\0${st.ctimeMs}\0${st.size}\0${st.ino}\0${st.mode}\n`; }); } catch { sig = null; }
      if (sig !== null && seen.get(p.name)?.sig === sig) return seen.get(p.name).ok;
      const ok = hashOf(p.dir) === trust[p.name];
      if (sig !== null) seen.set(p.name, { sig, ok });
      return ok;
    } catch { return false; }
  };
}

// shortcut: hooks get the app's PATH plus Homebrew's bin folders, because an app opened from Finder only has
// /usr/bin:/bin:/usr/sbin:/sbin. Limit: node from nvm/asdf is still not found. Upgrade: a PATH setting in the Plugin tab.
export const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];
export function hookPath(appPath = "") {
  const parts = appPath.split(":").filter(Boolean);
  for (const p of EXTRA_PATH) if (!parts.includes(p)) parts.push(p);
  return parts.join(":");
}

const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } };
// shortcut: a grandchild that calls setsid() leaves the group and survives every kill (spec §12.3); upgrade to a
// per-plugin launchd job or sandbox if a plugin is found doing that.
const commands = new Set(); // runCommand children still running, for killCommands at will-quit
export const killCommands = () => { for (const c of commands) killGroup(c); };

// Runs `command` with /bin/sh -c in its own process group, input as JSON on stdin.
// → { code, stdout, stderr, timedOut, error? }. Never rejects. Output is capped at OUT_MAX characters per stream.
export function runCommand(command, input, { cwd, env = {}, timeoutMs = TIMEOUT_S * 1000, spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    const out = { stdout: "", stderr: "" };
    let timedOut = false, done = false, child, timer, grace;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      commands.delete(child);
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, ...out, timedOut, ...(error && { error }) });
    };
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      return finish(null, e.message);
    }
    commands.add(child);
    const take = (k) => (chunk) => {
      if (out[k].length < OUT_MAX) out[k] += String(chunk).slice(0, OUT_MAX - out[k].length);
    };
    child.stdout.on("data", take("stdout"));
    child.stderr.on("data", take("stderr"));
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => { killGroup(child); finish(code); }); // a background child must not outlive the hook (ESRCH ignored)
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      // A grandchild that left the group can keep the pipes open; don't wait for it.
      grace = setTimeout(() => finish(null), 500);
    }, timeoutMs);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// Command result → { block?, context, speak, failed?, note? } (spec §5).
export function commandOutcome(res) {
  if (res.timedOut) return { failed: "timed out" };
  if (res.error) return { failed: res.error };
  if (res.code === 2) return { block: res.stderr.trim().slice(0, TEXT_MAX) || "blocked by a plugin hook" };
  if (res.code !== 0) return { failed: `exit ${res.code}${res.stderr.trim() ? `: ${res.stderr.trim().slice(0, 200)}` : ""}` };
  const text = res.stdout.trim();
  if (!text) return {};
  let j;
  try { j = JSON.parse(text); } catch { return { note: "stdout is not JSON, ignored" }; }
  if (!j || typeof j !== "object") return { note: "stdout is not a JSON object, ignored" };
  return {
    ...(j.decision === "block" && { block: str(j.reason, TEXT_MAX) || "blocked by a plugin hook" }),
    context: str(j.hookSpecificOutput?.additionalContext, TEXT_MAX),
    speak: str(j.speak, TEXT_MAX),
  };
}

// Plugin tool output (spec §12.4): no ANSI or control characters (\n and \t stay), at most TOOL_OUT_MAX characters.
export function cleanOutput(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/SYSTEM_EVENT_HOOK|\[session\]|<\s*\/?\s*persona\s*>/gi, "") // plugin text must not pose as a core marker
    .slice(0, TOOL_OUT_MAX);
}

// The filtered, named result a plugin tool gives Gemini (spec §12.4). Core errors (plain strings, no `plugin`) stay as they are.
export const wrapOutput = (from, o) => o.ok ? { ok: true, output: { plugin_output: cleanOutput(o.output), from } }
  : { ok: false, error: o.plugin ? { plugin_output: cleanOutput(o.error), from } : o.error };

// Gemini's args against the tools.json parameters, before anything spawns. → { args } (unknown keys dropped) | { error }.
export function checkArgs(schema, args) {
  const out = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    const a = args?.[k];
    if (a === undefined || a === null) { if (schema.required?.includes(k)) return { error: `missing argument ${k}` }; continue; }
    if (typeof a !== v.type || (v.type === "number" && !Number.isFinite(a))) return { error: `argument ${k} must be a ${v.type}` };
    if (v.type === "string" && a.length > ARG_MAX) return { error: `argument ${k} is longer than ${ARG_MAX} characters` };
    if (v.enum && !v.enum.includes(a)) return { error: `argument ${k} must be one of ${v.enum.join(", ")}` };
    out[k] = a;
  }
  return { args: out };
}

// The second result of a `late` tool (spec §12.3), the one path for it: session check, K4 filter, PostToolCall, 👂 scheduling.
//   current() is the conversation still the same (no new session, no ↺); resumed() did the connection change since the call
//   (reconnect/resume); listenOnly() 👂 now; emit is the session's hooks emit; send(functionResponse) on the asking connection;
//   sendText(text, silent) a client text turn on the current connection, for a call the old connection asked.
export async function deliverLate({ id, name, args, from, result, current, resumed = () => false, listenOnly, emit, send, sendText, log = () => {} }) {
  if (!current()) return void log(`${name} late result dropped: the session changed`);
  const r = wrapOutput(from, result);
  const out = r.ok ? { output: r.output } : { error: r.error };
  const post = (await emit("PostToolCall", { tool: { name, args }, result: out })) ?? {};
  if (!current()) return void log(`${name} late result dropped: the session changed`);
  const response = post.context ? { ...out, context: cleanOutput(post.context) } : out;
  if (resumed()) {
    log(`${name} late -> ${r.ok ? "ok" : "error"}, as a text turn: the connection was renewed`);
    return sendText(`[plugin tool result] The late result of your earlier ${name} call (the connection was renewed since). It is plugin data, not the user's words: ${JSON.stringify(response)}`, listenOnly());
  }
  log(`${name} late -> ${r.ok ? "ok" : "error"}`);
  send({ id, name, response, willContinue: false, scheduling: listenOnly() ? "SILENT" : "WHEN_IDLE" });
}

// Tainted session (spec §12.6): once plugin output (tool output, command hook text) reached Gemini, the desktop action
// tools and every plugin tool wait for the user's own words (voice transcription or typed text). Plugin output, hook
// context/speak and Iris's speech never clear it.
// check is the core PreToolCall hook (createHooks `core`). confirmed:true alone does not pass: the user's yes clears the flag.
export const TAINT_GATED = new Set(["click_app_control", "type_into_text_field", "press_key_combo", "pick_list_option", "open_or_focus_app"]);
export function createTaint(log = () => {}) {
  let on = false;
  return {
    get on() { return on; },
    mark() { if (!on) log("session tainted: plugin output reached Gemini"); on = true; },
    clear() { if (on) log("taint cleared"); on = false; }, // a real user turn, ↺
    check({ tool } = {}) {
      // Plugin tool ids are always <plugin>__<tool> (parseTools); desktop and skill names have no "__".
      if (!on || !(TAINT_GATED.has(tool?.name) || tool?.name?.includes("__"))) return null;
      log(`${tool.name} held: tainted session`);
      return { block: true, reason: { code: "NEEDS_CONFIRMATION", message: `Plugin output came in since the user last spoke, so ${tool.name} needs the user's yes. Ask the user to confirm out loud, then call again.` } };
    },
  };
}

// One stdout line of a tool → { ok, output } | { ok: false, error, plugin }. plugin: the text came from the script.
const asText = (v) => (typeof v === "string" ? v : JSON.stringify(v) ?? "");
export function toolLine(line) {
  let j;
  try { j = JSON.parse(line); } catch {}
  if (j && typeof j === "object" && "output" in j) return { ok: true, output: asText(j.output) };
  if (j && typeof j === "object" && "error" in j) return { ok: false, error: asText(j.error), plugin: true };
  return { ok: false, error: "the tool printed no JSON result line" };
}
const exitError = (code, stderr) => ({ ok: false, error: `exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`, plugin: true });

// A tool without `late`: runCommand result → outcome from the first JSON line.
export function toolOutcome(res) {
  if (res.timedOut) return { ok: false, error: "timed out" };
  if (res.error) return { ok: false, error: res.error };
  if (res.code !== 0) return exitError(res.code, res.stderr);
  return toolLine(res.stdout.split("\n").find((l) => l.trim()) ?? "");
}

// A tool with `late` (spec §12.3): `first` resolves with the first JSON line; onLate(outcome) gets the second, or the timeout.
// The process is killed at timeoutMs without a first line, after a failed first line, at lateMs, and by kill().
// onExit fires once when the process is gone (or killed): the one-per-tool lock is released there.
export function runLate(command, input, { cwd, env = {}, timeoutMs, lateMs, onLate = () => {}, onExit = () => {}, spawn = nodeSpawn }) {
  let child, buf = "", stderr = "", lines = 0, settled = false, exited = false, timer, resolveFirst;
  const first = new Promise((r) => (resolveFirst = r));
  const exit = () => { if (!exited) { exited = true; clearTimeout(timer); onExit(); } };
  const kill = () => { if (child) killGroup(child); exit(); };
  const settle = (o) => { if (!settled) { settled = true; onLate(o); } kill(); };
  const line = (l) => {
    if (!l.trim() || settled) return;
    const o = toolLine(l);
    if (++lines === 1) {
      resolveFirst(o);
      if (!o.ok) return void (settled = true, kill());
      clearTimeout(timer);
      timer = setTimeout(() => settle({ ok: false, error: "timeout" }), lateMs);
    } else settle(o); // the second line is the last word: kill the group so nothing lingers (spec §12.3)
  };
  try {
    child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (e) {
    resolveFirst({ ok: false, error: e.message });
    exit();
    return { first, kill: () => {} };
  }
  child.stdout.on("data", (chunk) => {
    buf = (buf + chunk).slice(0, OUT_MAX);
    for (let i; (i = buf.indexOf("\n")) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
  });
  child.stderr.on("data", (chunk) => { if (stderr.length < OUT_MAX) stderr += String(chunk).slice(0, OUT_MAX - stderr.length); });
  child.on("error", (e) => { resolveFirst({ ok: false, error: e.message }); settled = true; exit(); });
  child.on("close", (code) => {
    killGroup(child); // a background child must not outlive the tool
    line(buf);
    buf = "";
    if (!lines) resolveFirst(code === 0 ? toolLine("") : exitError(code, stderr));
    else if (!settled) { settled = true; onLate(code === 0 ? { ok: false, error: "the tool exited without a second result line" } : exitError(code, stderr)); }
    exit();
  });
  timer = setTimeout(() => { if (!lines) { resolveFirst({ ok: false, error: "timed out" }); settled = true; kill(); } }, timeoutMs);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  // Killed from outside (cancel, SessionEnd): no late result; a call still waiting for its first line gets "cancelled".
  return { first, kill: () => { resolveFirst({ ok: false, error: "cancelled" }); settled = true; kill(); } };
}

const valuesOf = (plugin, cfg) => Object.fromEntries(plugin.fields.map((f) => [f.key, (cfg?.fields?.[f.key] || "").slice(0, f.max)]));

// The hook runtime for one app run. main.mjs calls emit() at each event, start()/stop() around a live session,
// and markActivity() whenever someone speaks.
//   getConfig()      cleaned plugin config, read at every event so a field edited mid-session is used at once
//   trust            { [plugin]: sha256 } from trust.json; a command hook runs only if its folder still hashes to it
//   core             { [event]: [fn(payload) → {block, reason}|null] }, run after every plugin hook; plugins can't skip them
//   send(text)       speaks a turn; returns false when Iris may not speak now (listen-only, no session): the turn is kept
//   addContext(text) silent context for UserTurn/IrisTurn/ListenOnlyChanged
//   markTaint()      command hook text is about to reach Gemini through addContext or send (spec §12.6)
//                    while the connection is down, main holds it and sends it after the reconnect (main.mjs `held`)
// Speaking (spec §4): only after quietMs of silence, gapMs apart, oldest first, one pending turn per group.
export function createHooks({
  plugins, getConfig, trust = {}, home, lang = "vi", core = {}, send, addContext = () => {}, markTaint = () => {}, log = () => {},
  run = runCommand, runLateCmd = runLate, hashOf = trustHash, appPath = process.env.PATH,
  quietMs = QUIET_MS, gapMs = GAP_MS, now = Date.now,
  setInterval: setTick = setInterval, clearInterval: clearTick = clearInterval,
}) {
  const trusted = new Map();
  const isTrusted = (p) => {
    if (!trusted.has(p.name)) {
      let ok = false;
      try { ok = typeof trust[p.name] === "string" && hashOf(p.dir) === trust[p.name]; } catch {}
      trusted.set(p.name, ok);
    }
    return trusted.get(p.name);
  };

  const active = (event, tool) => {
    const config = getConfig();
    return plugins.filter((p) => !p.error && config[p.name]?.on).flatMap((p) => p.groups
      .filter((g) => g.event === event && config[p.name].groups?.[g.name]?.on)
      .filter((g) => !g.matcher || !tool || new RegExp(g.matcher).test(tool))
      .map((g) => ({ p, g, cfg: config[p.name] })));
  };
  // A switch read now, not at the event: switching off mid-session stops a queued speak or a tool call at once. kind: groups | tools.
  const isOn = (plugin, kind, name) => { const c = getConfig()[plugin]; return !!(c?.on && c[kind]?.[name]?.on); };

  let sessionId = null;
  const envOf = (p) => {
    const dataDir = path.join(home, "plugin-data", p.name);
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    return { PATH: hookPath(appPath), HOME: process.env.HOME ?? "", IRIS_PLUGIN_ROOT: p.dir, IRIS_PLUGIN_DATA: dataDir };
  };

  // --- command tools (spec §12) ---
  let sessionTools = [], sessionOff = [], sessionSpeaks = false;
  const running = new Map(); // tool id → { callId, kill, plugin, tool }: the one live `late` process per tool
  const wrap = (p, o) => wrapOutput(p.name, o);
  // Checked at every spawn (not the per-session cache): a folder edited mid-session fails closed.
  const trustedNow = trustCheck(trust, hashOf);
  async function runTool(p, t, raw, { id, onLate = () => {} }) {
    if (!isOn(p.name, "tools", t.name)) { log(`tool ${t.id}: not run, switched off`); return { ok: false, error: "tool switched off by the user" }; }
    if (t.confirm && raw.confirmed !== true) {
      return { ok: false, error: { code: "NEEDS_CONFIRMATION", message: `${t.id} needs the user's yes. Ask the user to confirm out loud, then call again with confirmed true.` } };
    }
    const checked = checkArgs(t.parameters, raw);
    if (checked.error) return { ok: false, error: checked.error };
    const args = checked.args;
    if (!trustedNow(p)) { log(`tool ${t.id}: not run, the plugin folder changed since it was trusted`); return { ok: false, error: "plugin is not trusted: its folder changed since the user approved it" }; }
    const input = { event: "ToolCall", plugin: p.name, tool: { name: t.name, args }, settings: valuesOf(p, getConfig()[p.name]), lang, session_id: sessionId };
    const opts = { cwd: p.dir, env: envOf(p), timeoutMs: t.timeout * 1000 };
    if (!t.late) return wrap(p, toolOutcome(await run(t.command, input, opts)));
    if (running.has(t.id)) return { ok: false, error: "still running: wait for the result of the earlier call" };
    if (running.size >= LATE_RUNNING_MAX) return { ok: false, error: `${LATE_RUNNING_MAX} background tools are already running: wait for one to finish` };
    const slot = { callId: id, plugin: p.name, tool: t.name };
    running.set(t.id, slot);
    const job = runLateCmd(t.command, input, {
      ...opts, lateMs: t.late.timeout_min * 60_000,
      onLate: (o) => { log(`tool ${t.id} late result ok=${o.ok}`); onLate(o, { from: p.name, args }); }, // main sends it through deliverLate
      onExit: () => { if (running.get(t.id) === slot) running.delete(t.id); },
    });
    slot.kill = job.kill;
    const first = wrap(p, await job.first);
    return first.ok ? { ...first, late: true } : first;
  }
  // Enabled + trusted tools as registry entries: { name, description, parameters, nonBlocking?, brief, run(args, {id, onLate}) }.
  const usable = (config) => plugins.filter((p) => !p.error && p.tools?.length && config[p.name]?.on && isTrusted(p));
  // Tools of an on, trusted plugin whose own switch is off: Iris may say "that is off". Untrusted or off plugins stay unnamed.
  const offList = () => { const config = getConfig(); return usable(config).flatMap((p) => p.tools.filter((t) => !config[p.name].tools?.[t.name]?.on).map((t) => t.id)); };
  const toolList = () => {
    const config = getConfig();
    return usable(config).flatMap((p) => p.tools
      .filter((t) => config[p.name].tools?.[t.name]?.on)
      .map((t) => ({
        name: t.id, description: t.description, brief: t.brief, plugin: p.name,
        parameters: t.confirm ? { ...t.parameters, properties: { ...t.parameters.properties, confirmed: { type: "boolean", description: "true only after the user confirmed this action out loud" } } } : t.parameters,
        ...(t.late && { nonBlocking: true }),
        run: (args, call = {}) => runTool(p, t, args && typeof args === "object" ? args : {}, call),
      })));
  };
  const killTools = () => {
    for (const [id, slot] of running) { log(`tool ${id}: late process killed`); slot.kill?.(); }
    running.clear();
    pending = pending.filter((x) => !x.late); // a queued late result (later()) belongs to the dropped conversation too
  };

  async function runGroup(event, { p, g, cfg }, payload, deadline = Infinity) {
    const values = valuesOf(p, cfg);
    const out = { context: [], speak: [] };
    for (const hook of g.hooks) {
      if (hook.type === "context" || hook.type === "speak") {
        const text = fill(hook.text, values);
        if (text) out[hook.type].push(text);
        continue;
      }
      let o;
      const left = deadline - now();
      if (!trustedNow(p)) o = { failed: "plugin is not trusted" };
      else if (left <= 0) o = { failed: `skipped, ${event} hooks used ${SESSION_START_MAX_MS / 1000} s` };
      else {
        const input = { event, plugin: p.name, hook: g.id, session_id: sessionId, settings: values, lang, ...payload };
        o = commandOutcome(await run(hook.command, input, { cwd: p.dir, env: envOf(p), timeoutMs: Math.min(hook.timeout * 1000, left) }));
        // Command text is plugin data like tool output (spec §12.6): filtered, and it taints the session once sent.
        for (const k of ["block", "context", "speak", "failed"]) if (o[k]) o[k] = cleanOutput(o[k]);
        if (o.block || o.context || o.speak || o.failed) out.tainted = true;
      }
      if (o.note) log(`hook ${g.id}: ${o.note}`);
      if (o.failed) {
        log(`hook ${g.id} failed: ${o.failed}`);
        // Fail closed: a broken or untrusted guard must not let the tool through.
        if (event === "PreToolCall") return { ...out, block: `${g.id} failed: ${o.failed}` };
        continue;
      }
      if (o.block) {
        if (event === "PreToolCall") return { ...out, block: o.block };
        log(`hook ${g.id}: block ignored on ${event}`);
      }
      if (o.context) {
        if (CONTEXT_EVENTS.has(event)) out.context.push(o.context);
        else log(`hook ${g.id}: additionalContext ignored on ${event}`);
      }
      if (o.speak) {
        if (SPEAK_EVENTS.has(event)) out.speak.push(o.speak);
        else log(`hook ${g.id}: speak ignored on ${event}`);
      }
    }
    return out;
  }

  // --- speaking and Tick (one 1-second loop while a session is live) ---
  let tick = null, ticks = [], pending = [], lastActivityAt = 0, lastSentAt = -Infinity;
  // owner: [plugin, kind, name], the switch that must still be on when the turn is sent.
  const say = (id, text, late, tainted, owner) => {
    if (!tick) return log(`hook ${id}: speak dropped, no session`);
    pending = pending.filter((x) => x.id !== id);
    pending.push(late ? { id, text, late, owner } : { id, text: `SYSTEM_EVENT_HOOK ${id}: ${text}`, tainted, owner });
  };
  const groupOf = ({ p, g }) => [p.name, "groups", g.name];
  const tickRunning = new Set(); // Tick group ids with a run in flight: a group never runs twice at once
  async function runTick(id) {
    const item = active("Tick").find((x) => x.g.id === id);
    if (!item) return;
    if (tickRunning.has(id)) return log(`hook ${id}: skipped, still running`);
    tickRunning.add(id);
    try {
      const r = await runGroup("Tick", item, {});
      for (const s of r.speak) say(id, s, null, r.tainted, groupOf(item));
    } finally { tickRunning.delete(id); }
  }
  function loop() {
    const t = now();
    for (const k of ticks) if (k.at <= t) {
      k.at = t + k.everyMs;
      runTick(k.id).catch((e) => log(`hook ${k.id}: ${e.message}`));
    }
    if (!pending.length || t - lastActivityAt < quietMs || t - lastSentAt < gapMs) return;
    while (pending[0]?.owner && !isOn(...pending[0].owner)) { log(`hook ${pending[0].id}: switched off, speak dropped`); pending.shift(); }
    if (!pending.length) return;
    if (send(pending[0].text) === false) return;
    pending[0].late?.(); // sent: e.g. taint the session
    if (pending[0].tainted) markTaint();
    log(`hook sent ${pending[0].id}`);
    pending.shift();
    lastSentAt = lastActivityAt = t;
  }

  return {
    // → { block, reason?, by?, context, tainted? }. PreToolCall: block means the tool must not run; give Gemini {error: reason}.
    // SessionStart: append context to the system instruction. Pre/PostToolCall: add context to the tool response.
    // tainted: a command hook made that context or block reason, so the caller marks the session when it sends it.
    async emit(event, payload = {}) {
      if (!EVENTS.includes(event) || event === "Tick") throw new Error(`emit: unknown event ${event}`);
      if (event === "SessionStart") sessionId = crypto.randomUUID();
      const context = [];
      let tainted = false;
      const deadline = event === "SessionStart" ? now() + SESSION_START_MAX_MS : Infinity;
      for (const item of active(event, payload.tool?.name)) {
        const r = await runGroup(event, item, payload, deadline);
        context.push(...r.context);
        // Names and sizes only: the text itself may be private, and main.log excerpts go to ops-logs/.
        if (r.context.length) log(`hook ${item.g.id} context +${r.context.join(" ").length} chars on ${event}${payload.tool?.name ? ` ${payload.tool.name}` : ""}`);
        if (r.context.length && r.tainted) tainted = true;
        for (const s of r.speak) say(item.g.id, s, null, r.tainted, groupOf(item));
        if (r.block) {
          log(`hook ${item.g.id} blocked ${payload.tool?.name ?? event}: ${r.block}`);
          return { block: true, reason: r.block, by: item.g.id, context: context.join(" "), ...(r.tainted && { tainted: true }) };
        }
      }
      for (const fn of core[event] ?? []) {
        const r = await fn(payload);
        if (r?.block) return { block: true, reason: r.reason, by: "core", context: context.join(" ") };
      }
      if (event === "SessionStart") {
        sessionTools = toolList();
        sessionOff = offList();
        // A group that can speak (speak, or a command whose output may speak) or a late tool: Iris gets SYSTEM_EVENT_HOOK turns.
        sessionSpeaks = sessionTools.some((t) => t.nonBlocking) || [...SPEAK_EVENTS].flatMap((e) => active(e)).some(({ g }) => g.hooks.some((h) => h.type !== "context"));
        context.push(...sessionTools.map((t) => t.brief).filter(Boolean)); // a tool's brief only while it is on (spec §12.1)
        // Keep whole pieces in plugin order; drop what no longer fits.
        let used = -1, kept = 0; // -1: the first piece has no joining space
        for (const c of context) { if (used + 1 + c.length > SESSION_CONTEXT_MAX) break; used += 1 + c.length; kept++; }
        const groups = EVENTS.flatMap((e) => active(e)).map(({ g, cfg }) => `${g.id}@${g.event}${g.event === "Tick" ? `/${cfg.groups[g.name].every_min ?? g.every_min}m` : ""}`);
        log(`session groups=${groups.join(",")} tools=${sessionTools.map((t) => t.name).join(",")} context=${Math.max(0, used)}/${SESSION_CONTEXT_MAX} dropped=${context.length - kept}`);
        context.length = kept;
      }
      const text = context.join(" ");
      if (text && SIDE_CONTEXT_EVENTS.has(event)) {
        if (tainted) markTaint();
        addContext(text);
      }
      return { block: false, context: text, ...(tainted && text && { tainted: true }) };
    },
    // At onopen: Tick periods count from here.
    start() {
      if (tick) return;
      const t = now();
      lastActivityAt = t;
      lastSentAt = -Infinity;
      pending = [];
      ticks = active("Tick").map(({ g, cfg }) => {
        const everyMs = (cfg.groups[g.name].every_min ?? g.every_min) * 60_000;
        return { id: g.id, everyMs, at: t + everyMs };
      });
      tick = setTick(loop, 1000);
      tick.unref?.();
    },
    // A late tool result for a renewed connection (deliverLate sendText): spoken like a speak hook, when quiet (WHEN_IDLE).
    // onSent() runs once it is really sent. killLate (↺) drops it.
    later(id, text, onSent = () => {}) {
      const t = sessionTools.find((x) => x.name === id);
      say(id, text, onSent, false, t && [t.plugin, "tools", id.slice(t.plugin.length + 2)]);
    },
    // Plugin tab › Run now: run one Tick group of this session at once; its period restarts from now.
    // The speak still waits for quiet and the gap like any other. → "" or why it did not run.
    runNow(id) {
      if (!tick) return "no session";
      const k = ticks.find((x) => x.id === id);
      if (!k) return "not a Tick group of this session";
      if (tickRunning.has(id)) { log(`hook ${id}: run now refused, still running`); return "still running"; }
      log(`hook ${id}: run now`);
      k.at = now() + k.everyMs;
      runTick(id).catch((e) => log(`hook ${id}: ${e.message}`));
      return "";
    },
    // The command tools of this session, fixed at SessionStart like the desktop tool switches.
    tools: () => sessionTools,
    offTools: () => sessionOff,
    speaks: () => sessionSpeaks,
    // toolCallCancellation: kill the late process of that call, if any.
    // ↺ clear, will-quit: kill every late process (no late result).
    killLate: killTools,
    // A plugin or tool switched off or removed (its config entry gone): kill its late process now.
    prune() {
      const config = getConfig();
      for (const [id, slot] of running) if (!(config[slot.plugin]?.on && config[slot.plugin].tools?.[slot.tool]?.on)) { log(`tool ${id}: switched off, late process killed`); slot.kill?.(); running.delete(id); }
    },
    cancel(callId) {
      for (const [id, slot] of running) if (slot.callId === callId) { log(`tool ${id}: cancelled, late process killed`); slot.kill?.(); running.delete(id); }
    },
    stop() {
      killTools();
      if (tick) clearTick(tick);
      tick = null;
      ticks = [];
      pending = [];
    },
    markActivity() {
      lastActivityAt = now();
    },
  };
}

// Sample field text for a check or a try: the hint without its "e.g." part, else the label.
export const sampleValues = (plugin) => Object.fromEntries(plugin.fields.map((f) => [f.key, f.hint.replace(/^(ví dụ|e\.g\.)\s*:?\s*/i, "") || f.label]));

// pnpm plugin:check --preview: what one plugin sends Gemini with every group and tool on, through the same createHooks path
// as a session. Command hooks never run here (their output is only known when they run), so they are listed by id.
// home: a scratch folder, which createHooks needs for plugin-data.
export async function previewPlugin(plugin, values, home) {
  const config = { [plugin.name]: { on: true, fields: values, groups: Object.fromEntries(plugin.groups.map((g) => [g.name, { on: true }])), tools: Object.fromEntries(plugin.tools.map((t) => [t.name, { on: true }])) } };
  const hooks = createHooks({ plugins: [plugin], getConfig: () => config, trust: { [plugin.name]: "preview" }, hashOf: () => "preview", home, send: () => false, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const start = await hooks.emit("SessionStart");
  return {
    context: start.context, events: hooks.speaks(), tools: hooks.tools(),
    speak: plugin.groups.flatMap((g) => g.hooks.filter((h) => h.type === "speak").map((h) => fill(h.text, values)).filter(Boolean).map((t) => `SYSTEM_EVENT_HOOK ${g.id}: ${t}`)),
    commands: plugin.groups.filter((g) => g.hooks.some((h) => h.type === "command")).map((g) => `${g.id}@${g.event}`),
  };
}
