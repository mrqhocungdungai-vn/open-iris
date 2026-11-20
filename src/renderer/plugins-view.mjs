// Plugin tab: pure helpers (no DOM), so they run under node --test. plugins-ui.js draws the cards.
// Data shape: the plugins:list contract (docs/plugin-hooks-spec.md): { name, version, description, error?, on, fields, groups, trust }.

export const t = (lang, vi, en) => (lang === "en" ? en : vi);

const EVENTS = {
  SessionStart: ["Bắt đầu phiên", "Session start"],
  SessionEnd: ["Kết thúc phiên", "Session end"],
  UserTurn: ["Bạn nói xong", "You finished"],
  IrisTurn: ["Iris nói xong", "Iris finished"],
  PreToolCall: ["Trước tool", "Before a tool"],
  PostToolCall: ["Sau tool", "After a tool"],
  ListenOnlyChanged: ["Đổi 👂 Chỉ nghe", "👂 Listen only changed"],
  Tick: ["Định kỳ", "Every few minutes"],
};
const KINDS = { context: ["thêm ngữ cảnh", "adds context"], speak: ["Iris nói", "Iris speaks"], command: ["chạy lệnh", "runs a command"] };

export const eventLabel = (lang, ev) => (EVENTS[ev] ? t(lang, ...EVENTS[ev]) : ev);
export const kindLabel = (lang, kind) => (KINDS[kind] ? t(lang, ...KINDS[kind]) : kind);
export const label = (lang, x) => (lang === "en" && x.label_en) || x.label || x.name || x.key;

// Tick period in minutes, 2–60 like main's clamp; junk falls back to the plugin's default.
export function clampEvery(value, fallback = 5) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && String(value).trim() !== "" ? Math.min(60, Math.max(2, n)) : fallback;
}

// Would this plugin run a command after the change? change = { on } for the plugin, { group, on } for one group or { tool, on } for one tool.
// Every plugin tool is a command tool (spec §12), so a tool that is on counts.
export function runsCommands(p, change) {
  const on = change.group || change.tool ? p.on : change.on;
  return !!on && (p.groups.some((g) => (g.name === change.group ? change.on : g.on) && g.commands.length > 0) ||
    (p.tools ?? []).some((t) => (t.name === change.tool ? change.on : t.on)));
}

// Turning something on that runs a command while the folder is not trusted: ask first (spec §6).
export const needsTrust = (p, change) => change.on && !!p.trust && !p.trust.approved && runsCommands(p, change);

// "none" (no commands), "ok", "new" (never approved) or "changed" (approved, then a file changed).
// Trust dialog: an extra warning when a command gets the spoken words verbatim.
export const hearsSpeech = (trust) => trust.commands.some((c) => c.event === "UserTurn" || c.event === "IrisTurn");

export function trustState(p) {
  if (!p.trust) return "none";
  if (p.trust.approved) return "ok";
  return p.trust.changed ? "changed" : "new";
}

// Settings › Agent Tools: does Iris get this plugin's tools? "ok", "off" (plugin off), "new" or "changed" (not trusted). Spec §12.2.
export function toolsState(p) {
  if (!p.on) return "off";
  const s = trustState(p);
  return s === "new" || s === "changed" ? s : "ok";
}

// Plugin card strip: how many command tools and how many are on; null without tools. Plural only in English.
export function toolsLine(lang, p) {
  const n = p.tools?.length ?? 0;
  if (!n) return null;
  const m = p.tools.filter((x) => x.on).length;
  return { none: m === 0, text: t(lang, `${n} tool · ${m} đang bật`, `${n} ${n === 1 ? "tool" : "tools"} · ${m} on`), link: t(lang, "Bật ở Agent Tools →", "Turn on in Agent Tools →") };
}

// savePlugin patches.
export const toolPatch = (p, tool, on) => ({ name: p.name, tools: { [tool.name]: { on } } });
export const pluginPatch = (p, on) => ({ name: p.name, on });
export const groupPatch = (p, g, change) => ({ name: p.name, groups: { [g.name]: change } });
export const fieldPatch = (p, f, value) => ({ name: p.name, fields: { [f.key]: String(value).slice(0, f.max || 500) } });
