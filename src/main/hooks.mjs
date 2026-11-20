// Plugin hooks (docs/plugin-hooks-spec.md, plugin API 1). Wired into main.mjs through createHooks().
// ~/.open-iris/plugins/<name>/
//   .open-iris-plugin/plugin.json  { name, version, open_iris_api, description, fields, components: { hooks: "./hooks/hooks.json" } }
//   hooks/hooks.json               { hooks: { <Event>: [{ name, label, label_en, matcher?, every_min?, hooks: [{ type, text|command, timeout? }] }] } }
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
export const TIMEOUT_S = 3, TIMEOUT_MAX_S = 10, TICK_TIMEOUT_MAX_S = 30;
export const OUT_MAX = 64 * 1024;
export const COMPONENTS = ["hooks"];

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

// One plugin → { name, version, api, description, fields, groups, hasCommand } or throws with the reason.
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

  return {
    name: dirName, version: str(meta.version, 32), api: meta.open_iris_api, description: str(meta.description, 300),
    fields: cleanFields, groups, hasCommand: groups.some((g) => g.hooks.some((h) => h.type === "command")),
  };
}

// One plugin folder from disk. Component files must resolve (after symlinks) inside the folder.
export function loadPlugin(dir) {
  const root = fs.realpathSync(dir);
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

// config.json → plugins: { [name]: { on, fields: {key: text}, groups: {[group]: {on, every_min}} } }. IPC/file trust boundary.
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
    out[name] = { on: p.on === true, fields, groups };
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

// sha256 over every file in the plugin folder, in name order: path, mode, size, bytes. Symlinks hash their target text.
// .DS_Store is skipped, since Finder writes it just by opening the folder.
export function trustHash(dir) {
  const h = crypto.createHash("sha256");
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (name === ".DS_Store") continue;
      const r = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, r);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink()) h.update(`link\0${r}\0${fs.readlinkSync(full)}\0`);
      else if (st.isFile()) {
        h.update(`file\0${r}\0${st.mode & 0o777}\0${st.size}\0`);
        h.update(fs.readFileSync(full));
      }
    }
  };
  walk("");
  return h.digest("hex");
}

// shortcut: hooks get the app's PATH plus Homebrew's bin folders, because an app opened from Finder only has
// /usr/bin:/bin:/usr/sbin:/sbin. Limit: node from nvm/asdf is still not found. Upgrade: a PATH setting in the Plugin tab.
export const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];
export function hookPath(appPath = "") {
  const parts = appPath.split(":").filter(Boolean);
  for (const p of EXTRA_PATH) if (!parts.includes(p)) parts.push(p);
  return parts.join(":");
}

// Runs `command` with /bin/sh -c in its own process group, input as JSON on stdin.
// → { code, stdout, stderr, timedOut, error? }. Never rejects. Output is capped at OUT_MAX characters per stream.
export function runCommand(command, input, { cwd, env = {}, timeoutMs = TIMEOUT_S * 1000, spawn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    const out = { stdout: "", stderr: "" };
    let timedOut = false, done = false, child, timer, grace;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, ...out, timedOut, ...(error && { error }) });
    };
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      return finish(null, e.message);
    }
    const take = (k) => (chunk) => {
      if (out[k].length < OUT_MAX) out[k] += String(chunk).slice(0, OUT_MAX - out[k].length);
    };
    child.stdout.on("data", take("stdout"));
    child.stderr.on("data", take("stderr"));
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
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

const valuesOf = (plugin, cfg) => Object.fromEntries(plugin.fields.map((f) => [f.key, (cfg?.fields?.[f.key] || "").slice(0, f.max)]));

// The hook runtime for one app run. main.mjs calls emit() at each event, start()/stop() around a live session,
// and markActivity() whenever someone speaks.
//   getConfig()      cleaned plugin config, read at every event so a field edited mid-session is used at once
//   trust            { [plugin]: sha256 } from trust.json; a command hook runs only if its folder still hashes to it
//   core             { [event]: [fn(payload) → {block, reason}|null] }, run after every plugin hook; plugins can't skip them
//   send(text)       speaks a turn; returns false when Iris may not speak now (listen-only, no session): the turn is kept
//   addContext(text) silent context for UserTurn/IrisTurn/ListenOnlyChanged
//     shortcut: context sent while the connection is down is lost; hold it in main when S3 (docs/session-plan.md) wires reconnect.
// Speaking (spec §4): only after quietMs of silence, gapMs apart, oldest first, one pending turn per group.
export function createHooks({
  plugins, getConfig, trust = {}, home, lang = "vi", core = {}, send, addContext = () => {}, log = () => {},
  run = runCommand, hashOf = trustHash, appPath = process.env.PATH,
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

  let sessionId = null;
  async function runGroup(event, { p, g, cfg }, payload) {
    const values = valuesOf(p, cfg);
    const out = { context: [], speak: [] };
    for (const hook of g.hooks) {
      if (hook.type === "context" || hook.type === "speak") {
        const text = fill(hook.text, values);
        if (text) out[hook.type].push(text);
        continue;
      }
      let o;
      if (!isTrusted(p)) o = { failed: "plugin is not trusted" };
      else {
        const input = { event, plugin: p.name, hook: g.id, session_id: sessionId, settings: values, lang, ...payload };
        const dataDir = path.join(home, "plugin-data", p.name);
        try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
        const env = { PATH: hookPath(appPath), HOME: process.env.HOME ?? "", IRIS_PLUGIN_ROOT: p.dir, IRIS_PLUGIN_DATA: dataDir };
        o = commandOutcome(await run(hook.command, input, { cwd: p.dir, env, timeoutMs: hook.timeout * 1000 }));
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
  const say = (id, text) => {
    if (!tick) return log(`hook ${id}: speak dropped, no session`);
    pending = pending.filter((x) => x.id !== id);
    pending.push({ id, text: `SYSTEM_EVENT_HOOK ${id}: ${text}` });
  };
  async function runTick(id) {
    const item = active("Tick").find((x) => x.g.id === id);
    if (!item) return;
    const r = await runGroup("Tick", item, {});
    for (const s of r.speak) say(id, s);
  }
  function loop() {
    const t = now();
    for (const k of ticks) if (k.at <= t) {
      k.at = t + k.everyMs;
      runTick(k.id).catch((e) => log(`hook ${k.id}: ${e.message}`));
    }
    if (!pending.length || t - lastActivityAt < quietMs || t - lastSentAt < gapMs) return;
    if (send(pending[0].text) === false) return;
    log(`hook sent ${pending[0].id}`);
    pending.shift();
    lastSentAt = lastActivityAt = t;
  }

  return {
    // → { block, reason?, by?, context }. PreToolCall: block means the tool must not run; give Gemini {error: reason}.
    // SessionStart: append context to the system instruction. Pre/PostToolCall: add context to the tool response.
    async emit(event, payload = {}) {
      if (!EVENTS.includes(event) || event === "Tick") throw new Error(`emit: unknown event ${event}`);
      if (event === "SessionStart") sessionId = crypto.randomUUID();
      const context = [];
      for (const item of active(event, payload.tool?.name)) {
        const r = await runGroup(event, item, payload);
        context.push(...r.context);
        for (const s of r.speak) say(item.g.id, s);
        if (r.block) {
          log(`hook ${item.g.id} blocked ${payload.tool?.name ?? event}: ${r.block}`);
          return { block: true, reason: r.block, by: item.g.id, context: context.join(" ") };
        }
      }
      for (const fn of core[event] ?? []) {
        const r = await fn(payload);
        if (r?.block) return { block: true, reason: r.reason, by: "core", context: context.join(" ") };
      }
      if (event === "SessionStart") {
        // Keep whole pieces in plugin order; drop what no longer fits.
        let used = -1, kept = 0; // -1: the first piece has no joining space
        for (const c of context) { if (used + 1 + c.length > SESSION_CONTEXT_MAX) break; used += 1 + c.length; kept++; }
        if (kept < context.length) log(`SessionStart context over ${SESSION_CONTEXT_MAX} chars: dropped ${context.length - kept} of ${context.length} pieces`);
        context.length = kept;
      }
      const text = context.join(" ");
      if (text && SIDE_CONTEXT_EVENTS.has(event)) addContext(text);
      return { block: false, context: text };
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
    stop() {
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
