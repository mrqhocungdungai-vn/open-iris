// plugins:list entry for the Plugin tab (docs/plugin-hooks-spec.md §8). Pure: main passes the saved config,
// the trust.json value and a hash function, so this runs under node --test.

// What a command hook gets on stdin besides the settings, by event: shown in the trust dialog.
const RECEIVES = {
  SessionStart: ["thông tin phiên", "session info"],
  SessionEnd: ["thông tin phiên", "session info"],
  UserTurn: ["nguyên văn lời bạn nói", "your exact words"],
  IrisTurn: ["nguyên văn lời Iris nói", "Iris's exact words"],
  PreToolCall: ["tên và tham số tool", "tool name and arguments"],
  PostToolCall: ["tên, tham số và kết quả tool", "tool name, arguments and result"],
  ListenOnlyChanged: ["trạng thái 👂 Chỉ nghe", "the 👂 Listen only state"],
  Tick: ["các ô cài đặt", "the settings fields"],
  ToolCall: ["tham số Gemini đưa vào tool (không đáng tin) và các ô cài đặt", "tool arguments from Gemini (untrusted) and the settings fields"],
};

// Shown above the command rows: there is no sandbox (spec §12).
const WARNING = [
  "Lệnh và tool của plugin được tin cậy chạy với quyền của bạn: chúng đọc được mọi file bạn đọc được, kể cả ~/.open-iris/.env (khoá Gemini).",
  "A trusted plugin's commands and tools run as you: they can read every file you can, including ~/.open-iris/.env (your Gemini key).",
];

// p: from loadPlugins. cfg: config.plugins[p.name]. saved: trust.json value for it. hashOf(dir) → sha256.
export function pluginEntry(p, cfg = {}, saved, hashOf, lang = "vi") {
  if (p.error) return { name: p.name, error: p.error };
  const en = lang === "en" ? 1 : 0;
  const groups = p.groups.map((g) => {
    const gc = cfg.groups?.[g.name] ?? {};
    return {
      id: g.id, name: g.name, event: g.event, label: g.label, label_en: g.label_en, on: gc.on === true,
      ...(g.matcher !== undefined && { matcher: g.matcher }),
      ...(g.event === "Tick" && { every_min: gc.every_min ?? g.every_min, every_min_default: g.every_min }),
      kinds: [...new Set(g.hooks.map((h) => h.type))],
      commands: g.hooks.filter((h) => h.type === "command").map((h) => h.command),
    };
  });
  const tools = (p.tools ?? []).map((t) => ({
    id: t.id, name: t.name, label: t.label, label_en: t.label_en, on: cfg.tools?.[t.name]?.on === true,
    confirm: t.confirm, late: !!t.late, command: t.command,
  }));
  let trust = null;
  if (p.hasCommand) {
    let approved = false;
    try { approved = typeof saved === "string" && hashOf(p.dir) === saved; } catch {}
    trust = {
      approved, changed: typeof saved === "string" && !approved, warning: WARNING[en],
      commands: groups.flatMap((g) => g.commands.map((command) => ({ group: g.name, event: g.event, matcher: g.matcher ?? "", command, receives: RECEIVES[g.event][en] })))
        .concat(tools.map((t) => ({ tool: t.name, event: "ToolCall", matcher: "", command: t.command, receives: RECEIVES.ToolCall[en] }))),
    };
  }
  return {
    name: p.name, version: p.version, description: p.description, api: p.api, on: cfg.on === true,
    fields: p.fields.map((f) => ({ ...f, value: cfg.fields?.[f.key] ?? "" })),
    groups, tools, trust,
  };
}
