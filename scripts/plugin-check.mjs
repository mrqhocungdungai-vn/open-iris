// pnpm plugin:check <plugin folder> [--preview]: load the folder with the core's own loader (hooks.mjs loadPlugin) and print
// the reason it is refused (exit 1), or a summary. --preview prints what would reach Gemini with every group and tool on:
// the plugin block of the system instruction, each speak turn with sample field text, the tool declarations. No network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlugin, previewPlugin, sampleValues } from "../src/main/hooks.mjs";
import { EVENTS_NOTE, liveSetup, pluginNotes } from "../src/main/live-config.mjs";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) { console.error("usage: pnpm plugin:check <plugin folder> [--preview]"); process.exit(2); }

let plugin;
// shortcut: the loader stops at the first problem, so one error per run; collect them all if authors ask for it.
try { plugin = loadPlugin(resolve(dir)); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
console.log(`ok ${plugin.name} ${plugin.version}: ${plugin.groups.length} hook groups, ${plugin.tools.length} tools${plugin.hasCommand ? ", runs commands (needs the user's trust)" : ""}`);
if (!args.includes("--preview")) process.exit(0);

const values = sampleValues(plugin);
const home = mkdtempSync(join(tmpdir(), "iris-check-"));
try {
  const p = await previewPlugin(plugin, values, home);
  console.log(`\nsample fields: ${JSON.stringify(values)}`);
  console.log(`\n--- system instruction, plugin part ---${p.events ? `\n${EVENTS_NOTE.trim()}` : ""}${p.context ? pluginNotes(p.context) : "\n(no plugin notes)"}`);
  console.log(`\n--- speak turns ---\n${p.speak.join("\n") || "(none)"}`);
  if (p.commands.length) console.log(`\n--- command hooks (not run here; their output is known only when they run) ---\n${p.commands.join("\n")}`);
  const decl = liveSetup("en", p.tools).tools?.[0].functionDeclarations ?? [];
  console.log(`\n--- tool declarations ---\n${decl.length ? JSON.stringify(decl, null, 2) : "(none)"}`);
} finally { rmSync(home, { recursive: true, force: true }); }
