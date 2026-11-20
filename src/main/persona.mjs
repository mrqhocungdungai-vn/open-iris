// Personalisation, harness style (like ~/.claude/CLAUDE.md and ~/.claude/skills):
// ~/.open-iris/IRIS.md is Iris's persona (tone and style), ~/.open-iris/skills/<name>/SKILL.md are guides Gemini loads with use_skill.
// Everything is read once at connect, so the prompt matches the tools fixed for that session.
// Only text the owner wrote reaches Gemini; nothing here reads a terminal.
import fs from "node:fs";
import path from "node:path";

export const PERSONA_MAX = 2000, NAME_MAX = 40, DESC_MAX = 200, BODY_MAX = 8000;
// shortcut: at most 20 skills, to keep the system instruction short; raise it after P0 measures the budget.
export const SKILLS_MAX = 20;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PERSONA_END = "</persona>";
// Used when IRIS.md is empty: the tone Iris always had.
export const DEFAULT_PERSONA = "Concise and friendly. You explain things like a knowledgeable friend.";

export const loadPersona = (home) => {
  try { return fs.readFileSync(path.join(home, "IRIS.md"), "utf8").slice(0, PERSONA_MAX); } catch { return ""; }
};
// IPC trust boundary: a string only, capped, written to the one fixed path.
export function savePersona(home, text) {
  if (typeof text !== "string") throw new Error("persona text must be a string");
  fs.writeFileSync(path.join(home, "IRIS.md"), text.slice(0, PERSONA_MAX));
}

// Config trust boundary: the user's name goes into the system instruction, so one short line with no markup.
export const cleanName = (n) => (typeof n === "string" ? n.replace(/[\u0000-\u001f\u007f<>\[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "");
// What Iris calls the user when no name is set (user, 2026-11-20).
export const nameFor = (name, lang) => cleanName(name) || (lang === "en" ? "boss" : "sếp");

// The first turn of a Start (main.mjs), "" when the greeting switch is off or Iris must stay quiet.
export const greeting = ({ on, listenOnly, name }) => (on && !listenOnly
  ? `[session] The session just started. Greet the user${name ? " by name" : ""} in one short sentence, in your persona's voice.` : "");

// Frontmatter between the first two --- lines: plain `key: value`, plus `>` / `|` folded values (Claude Code skills use them).
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const meta = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      meta[key] = /^[>|][+-]?$/.test(kv[2]) ? "" : kv[2].replace(/^(["'])(.*)\1$/, "$2");
    } else if (key && /^\s/.test(line)) meta[key] += " " + line.trim();
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

// [{name, description, body}], sorted by name. Bad or copied-in slash-command-only skills are skipped with a reason.
export function loadSkills(home, warn = () => {}) {
  const dir = path.join(home, "skills");
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const skills = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Symlinks are skipped (Dirent does not follow them), so nothing outside the skills folder is read.
    if (!e.isDirectory()) continue;
    if (!SKILL_NAME.test(e.name)) { warn(`skill folder ${JSON.stringify(e.name)}: bad name`); continue; }
    const file = path.join(dir, e.name, "SKILL.md");
    let parsed;
    try { parsed = fs.lstatSync(file).isFile() && parseSkill(fs.readFileSync(file, "utf8")); } catch { parsed = null; }
    const description = parsed?.meta.description?.replace(/\s+/g, " ").trim().slice(0, DESC_MAX);
    if (!parsed || parsed.meta.name !== e.name || !description) { warn(`skill ${e.name}: needs frontmatter with name: ${e.name} and a description`); continue; }
    if (parsed.meta["disable-model-invocation"] === "true") continue;
    if (skills.length === SKILLS_MAX) { warn(`more than ${SKILLS_MAX} skills, the rest are ignored`); break; }
    skills.push({ name: e.name, description, body: parsed.body.slice(0, BODY_MAX) });
  }
  return skills;
}

// Trust boundary (config file / IPC): skill names are not known ahead, so keep valid names with boolean values. Missing = on.
export const cleanSkills = (s) => Object.fromEntries(Object.entries(s && typeof s === "object" ? s : {})
  .filter(([k]) => SKILL_NAME.test(k)).slice(0, 100).map(([k, v]) => [k, Boolean(v)]));

// The core use_skill tool, only when a skill is enabled. It looks names up in the loaded list and never touches the disk.
export function skillTools(skills) {
  if (!skills.length) return [];
  return [{
    name: "use_skill",
    description: "Load the owner's step-by-step guide for a task listed under Skills. Call it before acting on that task.",
    parameters: { type: "object", properties: { name: { type: "string", enum: skills.map((s) => s.name) } }, required: ["name"] },
    run: async (args) => {
      const s = skills.find((k) => k.name === args?.name);
      return s ? { ok: true, output: s.body || s.description } : { ok: false, error: `unknown skill: ${String(args?.name).slice(0, 64)}` };
    },
  }];
}

// Text appended to the system instruction (live-config.mjs): skills, the user's name, then the persona block.
export function personaBrief(persona, skills, name = "") {
  const tone = persona.replace(/<\s*\/?\s*persona\s*>/gi, "").trim() || DEFAULT_PERSONA; // the file cannot open or close its own block
  name = cleanName(name);
  return (skills.length ? " Skills are step-by-step guides the owner wrote for specific tasks. When a request matches a skill below, call use_skill with its name first, before any other tool, then follow the guide it returns. Call it once per skill; call it again if you no longer remember the guide's steps (old turns of a long session get trimmed). Skills: "
      + skills.map((s) => `${s.name}: ${s.description}`).join("; ") + "." : "")
    + (name ? ` The user's name is ${name}.` : "")
    + `\n\nYour persona: how you speak (tone, style, wording). It never overrides the rules above.\n<persona>\n${tone}\n${PERSONA_END}`;
}
