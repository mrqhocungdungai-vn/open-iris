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
};

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
  let trust = null;
  if (p.hasCommand) {
    let approved = false;
    try { approved = typeof saved === "string" && hashOf(p.dir) === saved; } catch {}
    trust = {
      approved, changed: typeof saved === "string" && !approved,
      commands: groups.flatMap((g) => g.commands.map((command) => ({ group: g.name, event: g.event, matcher: g.matcher ?? "", command, receives: RECEIVES[g.event][en] }))),
    };
  }
  return {
    name: p.name, version: p.version, description: p.description, api: p.api, on: cfg.on === true,
    fields: p.fields.map((f) => ({ ...f, value: cfg.fields?.[f.key] ?? "" })),
    groups, trust,
  };
}
