// node plugin-install.selftest.mjs — Plugin tab › add from a folder (plugin-install.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPlugins, installFrom, parseGithubUrl, scanPlugins } from "./plugin-install.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iris-install-"));
const write = (file, data) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)));
const plugin = (dir, name = path.basename(dir), extra = {}) =>
  write(path.join(dir, ".open-iris-plugin", "plugin.json"), { name, version: "1.0.0", open_iris_api: 1, description: "x", ...extra });

// A repo laid out like open-iris-plugins: plugins/<name>/, plus a .git that must not be copied.
const repo = path.join(tmp, "clone");
plugin(path.join(repo, "plugins", "app-guard"));
plugin(path.join(repo, "plugins", "livestream"));
write(path.join(repo, "plugins", "livestream", "notes.txt"), "v1");
write(path.join(repo, "plugins", "livestream", ".git", "HEAD"), "ref");
plugin(path.join(repo, "plugins", "broken"), "Bad Name");
fs.mkdirSync(path.join(repo, "plugins", "not-a-plugin"));

const dest = path.join(tmp, "home", "plugins"); // does not exist yet
assert.deepEqual(findPlugins(repo).map((d) => path.basename(d)), ["app-guard", "broken", "livestream"]);
assert.deepEqual(findPlugins(path.join(repo, "plugins", "livestream")).map((d) => path.basename(d)), ["livestream"]); // one plugin
assert.deepEqual(findPlugins(path.join(repo, "plugins")).length, 3); // a folder of plugins

let r = installFrom(repo, dest);
assert.deepEqual(r.installed, ["app-guard", "livestream"]);
assert.equal(r.errors.length, 1);
assert.equal(r.errors[0].name, "broken");
assert.match(r.errors[0].error, /not a valid plugin name/);
assert.equal(fs.readFileSync(path.join(dest, "livestream", "notes.txt"), "utf8"), "v1");
assert.ok(!fs.existsSync(path.join(dest, "livestream", ".git")));
assert.ok(!fs.existsSync(path.join(dest, "broken")));

// Adding again replaces the old copy: a file removed from the clone goes away too.
fs.rmSync(path.join(repo, "plugins", "livestream", "notes.txt"));
write(path.join(repo, "plugins", "livestream", "new.txt"), "v2");
r = installFrom(path.join(repo, "plugins", "livestream"), dest);
assert.deepEqual(r, { installed: ["livestream"], errors: [] });
assert.ok(!fs.existsSync(path.join(dest, "livestream", "notes.txt")));
assert.equal(fs.readFileSync(path.join(dest, "livestream", "new.txt"), "utf8"), "v2");
assert.deepEqual(fs.readdirSync(dest).sort(), ["app-guard", "livestream"]); // no temp folder left

// A newer plugin API is refused and the installed copy stays.
plugin(path.join(repo, "plugins", "livestream"), "livestream", { open_iris_api: 99 });
r = installFrom(path.join(repo, "plugins", "livestream"), dest);
assert.deepEqual(r.installed, []);
assert.ok(fs.existsSync(path.join(dest, "livestream", "new.txt")));

// A clone of a one-plugin repo: plugin.json at the root, folder named differently; installed under plugin.json's name.
const single = path.join(tmp, "open-iris-hello");
plugin(single, "hello");
assert.deepEqual(installFrom(single, dest), { installed: ["hello"], errors: [] });
assert.ok(fs.existsSync(path.join(dest, "hello", ".open-iris-plugin", "plugin.json")));
fs.rmSync(path.join(dest, "hello"), { recursive: true });

// A symlink to a file outside the plugin (spec §6) is refused at install, even one no component uses; nothing is left behind.
const sneaky = path.join(tmp, "sneaky");
plugin(sneaky);
write(path.join(tmp, "secret.txt"), "x");
fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(sneaky, "run.sh"));
r = installFrom(sneaky, dest);
assert.deepEqual(r.installed, []);
assert.match(r.errors[0].error, /run\.sh points outside the plugin folder/);
assert.ok(!fs.existsSync(path.join(dest, "sneaky")));

// Nothing to add; picking the plugins folder itself adds nothing.
assert.match(installFrom(fs.mkdtempSync(path.join(tmp, "empty-")), dest).errors[0].error, /no .open-iris-plugin/);
r = installFrom(dest, dest);
assert.deepEqual(r.installed, []);
assert.ok(r.errors.every((e) => /already in the plugins folder/.test(e.error)));

// The add checklist: scan, then install only the ticked paths.
plugin(path.join(repo, "plugins", "livestream"), "livestream", { description: "Live" });
const scan = scanPlugins(repo, dest);
assert.deepEqual(scan.map((p) => [p.path, p.name, p.installed ?? null, !!p.error]), [
  ["plugins/app-guard", "app-guard", true, false], ["plugins/broken", "broken", null, true], ["plugins/livestream", "livestream", true, false]]);
assert.equal(scan[2].description, "Live");
assert.equal(scanPlugins(single, dest)[0].path, ".");
fs.rmSync(path.join(dest, "app-guard"), { recursive: true });
assert.deepEqual(installFrom(repo, dest, ["plugins/livestream"]), { installed: ["livestream"], errors: [] });
assert.ok(!fs.existsSync(path.join(dest, "app-guard")));
assert.deepEqual(installFrom(repo, dest, []), { installed: [], errors: [] });

// GitHub links: repo, repo.git, a folder on a branch; anything that could reach git as an option or leave the clone is refused.
assert.deepEqual(parseGithubUrl(" https://github.com/me/open-iris-plugins "), { repo: "https://github.com/me/open-iris-plugins.git", branch: "", sub: "" });
assert.deepEqual(parseGithubUrl("https://github.com/me/r.git/"), { repo: "https://github.com/me/r.git", branch: "", sub: "" });
assert.deepEqual(parseGithubUrl("https://github.com/me/r/tree/main/plugins/livestream"), { repo: "https://github.com/me/r.git", branch: "main", sub: "plugins/livestream" });
for (const bad of ["http://github.com/me/r", "https://gitlab.com/me/r", "https://github.com/me", "https://github.com/me/r/blob/main/x",
  "https://github.com/me/r/tree/-x", "https://github.com/me/r/tree/main/a%20b", "https://github.com/-u/r", "https://a@github.com/me/r", "git@github.com:me/r.git", "nope"])
  assert.equal(parseGithubUrl(bad), null, bad);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("plugin-install selftest ok");
