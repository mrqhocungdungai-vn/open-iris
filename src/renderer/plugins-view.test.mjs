import assert from "node:assert/strict";
import { test } from "node:test";
import { clampEvery, eventLabel, fieldPatch, groupPatch, hearsSpeech, label, needsTrust, runsCommands, trustState } from "./plugins-view.mjs";

const plugin = (over = {}) => ({
  name: "block-bank", on: false, fields: [{ key: "topic", max: 5 }],
  groups: [
    { name: "say", on: true, commands: [] },
    { name: "guard", on: false, commands: ["node ./hooks/x.mjs"] },
  ],
  trust: { approved: false, changed: false, commands: [] },
  ...over,
});

test("labels follow the language and fall back", () => {
  assert.equal(eventLabel("vi", "Tick"), "Định kỳ");
  assert.equal(eventLabel("en", "Tick"), "Every few minutes");
  assert.equal(eventLabel("en", "Unknown"), "Unknown");
  assert.equal(label("en", { label: "Chủ đề", label_en: "Topic" }), "Topic");
  assert.equal(label("en", { label: "Chủ đề" }), "Chủ đề");
  assert.equal(label("vi", { key: "goal" }), "goal");
});

test("clampEvery keeps 2–60 and falls back on junk", () => {
  assert.equal(clampEvery("1"), 2);
  assert.equal(clampEvery(90), 60);
  assert.equal(clampEvery("7.4"), 7);
  assert.equal(clampEvery("", 5), 5);
  assert.equal(clampEvery("abc", 7), 7);
});

test("runsCommands looks at the state after the change", () => {
  const p = plugin();
  assert.equal(runsCommands(p, { on: true }), false); // only the command group is off
  assert.equal(runsCommands(p, { group: "guard", on: true }), false); // plugin itself is off
  assert.equal(runsCommands({ ...p, on: true }, { group: "guard", on: true }), true);
  assert.equal(runsCommands(plugin({ groups: [{ name: "guard", on: true, commands: ["x"] }] }), { on: true }), true);
});

test("needsTrust only when turning on a command while untrusted", () => {
  const p = plugin({ on: true });
  assert.equal(needsTrust(p, { group: "guard", on: true }), true);
  assert.equal(needsTrust(p, { group: "guard", on: false }), false);
  assert.equal(needsTrust({ ...p, trust: { approved: true } }, { group: "guard", on: true }), false);
  assert.equal(needsTrust({ ...p, trust: null }, { group: "guard", on: true }), false);
  assert.equal(needsTrust(p, { group: "say", on: true }), false);
});

test("trustState", () => {
  assert.equal(trustState(plugin({ trust: null })), "none");
  assert.equal(trustState(plugin({ trust: { approved: true } })), "ok");
  assert.equal(trustState(plugin()), "new");
  assert.equal(trustState(plugin({ trust: { approved: false, changed: true } })), "changed");
});

test("patches match the savePlugin contract", () => {
  const p = plugin();
  assert.deepEqual(groupPatch(p, p.groups[0], { every_min: 5 }), { name: "block-bank", groups: { say: { every_min: 5 } } });
  assert.deepEqual(fieldPatch(p, p.fields[0], "abcdefgh"), { name: "block-bank", fields: { topic: "abcde" } });
});

test("hearsSpeech only for UserTurn/IrisTurn commands", () => {
  assert.equal(hearsSpeech({ commands: [{ event: "PreToolCall" }] }), false);
  assert.equal(hearsSpeech({ commands: [{ event: "PreToolCall" }, { event: "IrisTurn" }] }), true);
});
