// Plugin tab › "Add from a folder": copy plugins from a folder on this Mac (e.g. a git clone) into ~/.open-iris/plugins/.
// The chosen folder can be one plugin, a folder of plugins, or a repo with plugins/<name>/ (like open-iris-plugins).
// A copy, not a link: the clone can move or go away. Updating = git pull, then add again; new files need trust again.
import fs from "node:fs";
import path from "node:path";
import { loadPlugin, NAME } from "./hooks.mjs";

const isPlugin = (dir) => fs.existsSync(path.join(dir, ".open-iris-plugin", "plugin.json"));
const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => path.join(dir, d.name)).sort();
  } catch {
    return [];
  }
};

// Plugin folders inside `dir`: itself, else its subfolders, else plugins/*.
export function findPlugins(dir) {
  if (isPlugin(dir)) return [dir];
  const direct = subdirs(dir).filter(isPlugin);
  return direct.length ? direct : subdirs(path.join(dir, "plugins")).filter(isPlugin);
}

// What the add checklist shows: { path (relative to dir), name, version, description, installed } or { path, name, error }.
// Only plugin.json is read here; installFrom checks the whole plugin.
export function scanPlugins(dir, pluginsDir) {
  return findPlugins(dir).map((src) => {
    const rel = path.relative(dir, src) || ".";
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(src, ".open-iris-plugin", "plugin.json"), "utf8"));
      if (typeof meta.name !== "string" || !NAME.test(meta.name)) throw new Error(`plugin.json name ${JSON.stringify(meta.name)} is not a valid plugin name`);
      const str = (v) => (typeof v === "string" ? v.slice(0, 300) : "");
      return { path: rel, name: meta.name, version: str(meta.version), description: str(meta.description), installed: fs.existsSync(path.join(pluginsDir, meta.name)) };
    } catch (e) {
      return { path: rel, name: path.basename(src), error: e.message };
    }
  });
}

// "https://github.com/<owner>/<repo>[.git][/tree/<branch>[/<folder>…]]" → { repo, branch, sub } or null. Every segment starts
// with a letter or digit, so nothing reaches git as an option or climbs out with "..".
// shortcut: the branch is one segment (no "feature/x"), upgrade with git ls-remote if someone needs slashed branches.
export function parseGithubUrl(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username || u.password || u.port || u.search) return null;
  const [owner, repo, tree, branch, ...sub] = u.pathname.split("/").filter(Boolean);
  const seg = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
  if (![owner, repo].every((s) => seg.test(s ?? ""))) return null;
  if (tree !== undefined && (tree !== "tree" || !seg.test(branch ?? ""))) return null;
  if (!sub.every((s) => seg.test(s))) return null;
  return { repo: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`, branch: branch ?? "", sub: sub.join("/") };
}

// → { installed: [name], errors: [{ name, error }] }. A plugin of the same name is replaced; its switches and field values
// live in config.json, so they stay. Nothing is turned on here. picks: paths from scanPlugins to install (default: all).
export function installFrom(dir, pluginsDir, picks) {
  const result = { installed: [], errors: [] };
  fs.mkdirSync(pluginsDir, { recursive: true });
  const root = fs.realpathSync(pluginsDir);
  const found = findPlugins(dir).filter((src) => !picks || picks.includes(path.relative(dir, src) || "."));
  if (!found.length && !picks) result.errors.push({ name: path.basename(dir), error: "no .open-iris-plugin/plugin.json here, in its subfolders or in plugins/" });
  for (const src of found) {
    let name = path.basename(src);
    const real = fs.realpathSync(src);
    if (real.startsWith(root + path.sep)) {
      result.errors.push({ name, error: "already in the plugins folder" });
      continue;
    }
    // The installed folder is named after plugin.json's name, so a clone called open-iris-hello still works.
    // Copy into .adding/<name>/ first: loadPlugin there checks the copy, and a failure never replaces the old plugin.
    const stage = path.join(root, ".adding");
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(real, ".open-iris-plugin", "plugin.json"), "utf8"));
      if (typeof meta.name !== "string" || !NAME.test(meta.name)) throw new Error(`plugin.json name ${JSON.stringify(meta.name)} is not a valid plugin name`);
      name = meta.name;
      const tmp = path.join(stage, name);
      fs.rmSync(stage, { recursive: true, force: true });
      fs.cpSync(real, tmp, { recursive: true, verbatimSymlinks: true, filter: (p) => path.basename(p) !== ".git" });
      loadPlugin(tmp); // name, manifest, files inside the folder
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      fs.renameSync(tmp, path.join(root, name));
      result.installed.push(name);
    } catch (e) {
      result.errors.push({ name, error: e.message });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  return result;
}
