import assert from "node:assert/strict";
import { test } from "node:test";
import { clampEvery, eventLabel, fieldPatch, groupPatch, hearsSpeech, label, needsTrust, runsCommands, toolPatch, toolsLine, toolsState, trustState } from "./plugins-view.mjs";

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

test("command tools count for runsCommands and needsTrust", () => {
  const p = plugin({ on: true, tools: [{ name: "start_job", on: false }] });
  assert.equal(needsTrust(p, { tool: "start_job", on: true }), true); // first tool on, untrusted: ask
  assert.equal(needsTrust(p, { tool: "start_job", on: false }), false);
  assert.equal(needsTrust({ ...p, trust: { approved: true } }, { tool: "start_job", on: true }), false);
  assert.equal(needsTrust({ ...p, on: false }, { tool: "start_job", on: true }), false); // plugin off: asked when it is turned on
  const off = plugin({ tools: [{ name: "start_job", on: true }] });
  assert.equal(needsTrust(off, { on: true }), true); // plugin on with a tool already on
  assert.equal(runsCommands(off, { on: true }), true);
});

test("toolsLine counts tools and on, plural only in English", () => {
  assert.equal(toolsLine("vi", plugin()), null);
  assert.equal(toolsLine("en", plugin({ tools: [] })), null);
  const one = plugin({ tools: [{ name: "a", on: false }] });
  assert.deepEqual(toolsLine("en", one), { none: true, text: "1 tool · 0 on", link: "Turn on in Agent Tools →" });
  const three = plugin({ tools: [{ name: "a", on: true }, { name: "b", on: false }, { name: "c", on: false }] });
  assert.deepEqual(toolsLine("vi", three), { none: false, text: "3 tool · 1 đang bật", link: "Bật ở Agent Tools →" });
  assert.equal(toolsLine("en", three).text, "3 tools · 1 on");
});

test("toolsState: off wins, then never trusted vs changed", () => {
  assert.equal(toolsState(plugin()), "off");
  assert.equal(toolsState(plugin({ trust: { approved: false, changed: true } })), "off");
  assert.equal(toolsState(plugin({ on: true })), "new");
  assert.equal(toolsState(plugin({ on: true, trust: { approved: false, changed: true } })), "changed");
  assert.equal(toolsState(plugin({ on: true, trust: { approved: true } })), "ok");
  assert.equal(toolsState(plugin({ on: true, trust: null })), "ok");
});

test("toolPatch matches config:plugin { name, tools: { [tool]: { on } } }", () => {
  assert.deepEqual(toolPatch(plugin(), { name: "start_job" }, true), { name: "block-bank", tools: { start_job: { on: true } } });
});

test("hearsSpeech only for UserTurn/IrisTurn commands", () => {
  assert.equal(hearsSpeech({ commands: [{ event: "PreToolCall" }] }), false);
  assert.equal(hearsSpeech({ commands: [{ event: "PreToolCall" }, { event: "IrisTurn" }] }), true);
});
