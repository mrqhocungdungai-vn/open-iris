import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginEntry } from "./plugin-list.mjs";

const p = {
  name: "demo", version: "1.0.0", description: "d", api: 1, dir: "/x", hasCommand: true,
  fields: [{ key: "topic", label: "Chủ đề", label_en: "Topic", hint: "", max: 200 }],
  groups: [
    { id: "demo/brief", name: "brief", event: "SessionStart", label: "Brief", label_en: "", hooks: [{ type: "context", text: "T {topic}." }] },
    { id: "demo/recap", name: "recap", event: "Tick", label: "Recap", label_en: "", every_min: 5, hooks: [{ type: "speak", text: "R." }] },
    { id: "demo/guard", name: "guard", event: "PreToolCall", label: "Guard", label_en: "", matcher: "open_.*", hooks: [{ type: "command", command: "node g.mjs", timeout: 3 }] },
  ],
};

test("values, switches and Tick periods come from the config", () => {
  const e = pluginEntry(p, { on: true, fields: { topic: "AI" }, groups: { recap: { on: true, every_min: 9 } } }, undefined, () => "h");
  assert.equal(e.on, true);
  assert.equal(e.fields[0].value, "AI");
  assert.deepEqual(e.groups.map((g) => g.on), [false, true, false]);
  assert.equal(e.groups[1].every_min, 9);
  assert.equal(e.groups[1].every_min_default, 5);
  assert.deepEqual(e.groups[2].kinds, ["command"]);
  assert.deepEqual(e.groups[2].commands, ["node g.mjs"]);
});

test("trust: new, approved, changed; null without commands", () => {
  assert.deepEqual([pluginEntry(p, {}, undefined, () => "h").trust.approved, pluginEntry(p, {}, undefined, () => "h").trust.changed], [false, false]);
  assert.equal(pluginEntry(p, {}, "h", () => "h").trust.approved, true);
  const changed = pluginEntry(p, {}, "old", () => "h", "en").trust;
  assert.deepEqual([changed.approved, changed.changed], [false, true]);
  assert.deepEqual(changed.commands, [{ group: "guard", event: "PreToolCall", matcher: "open_.*", command: "node g.mjs", receives: "tool name and arguments" }]);
  assert.equal(pluginEntry({ ...p, hasCommand: false }, {}, undefined, () => "h").trust, null);
  assert.equal(pluginEntry(p, {}, "h", () => { throw new Error("gone"); }).trust.approved, false);
});

test("a broken plugin is just its name and error", () => {
  assert.deepEqual(pluginEntry({ name: "bad", error: "boom" }), { name: "bad", error: "boom" });
});
