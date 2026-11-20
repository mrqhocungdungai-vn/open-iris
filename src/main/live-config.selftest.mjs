// node live-config.selftest.mjs — keyFormatOk accepts both Gemini key styles and rejects junk; the instruction has no coding text. Keys below are fake.
import assert from "node:assert/strict";
import { desktopTools } from "./desktop.mjs";
import { keyFormatOk, liveSetup } from "./live-config.mjs";

assert.ok(keyFormatOk("AIzaSyFAKEfake0000000000000000000_-abcd"), "classic AIza key");
assert.ok(keyFormatOk("AQ.FakeFakeFake0000000000000000000000000"), "newer AQ. key with a dot");
assert.ok(!keyFormatOk("short"), "too short");
assert.ok(!keyFormatOk("AIza key with spaces 1234567890"), "spaces");
assert.ok(!keyFormatOk("x".repeat(201)), "too long");

// With every desktop tool on, the instruction has no coding-tool text but keeps the terminal and [gallery] rules.
const text = liveSetup("vi", desktopTools()).systemInstruction.parts[0].text;
assert.ok(!text.includes("coding_task"), "no coding_task");
assert.ok(text.includes(" Never use the app tools to read a terminal window."), "terminal sentence");
assert.ok(text.includes("A message starting with [gallery] is silent context"), "[gallery] sentence");
assert.ok(!text.includes("Claude Code"), "no Claude Code");

// Giữ phiên dài: off adds nothing; on asks for handles and compression; a handle resumes that session.
const tools = desktopTools();
const off = liveSetup("vi", tools);
assert.ok(!("sessionResumption" in off) && !("contextWindowCompression" in off), "keep off: no resume keys");
const on = liveSetup("vi", tools, "", { keep: true });
assert.deepEqual(on.sessionResumption, {}, "keep on, no handle: ask for handles");
assert.deepEqual(on.contextWindowCompression, { slidingWindow: {} }, "keep on: sliding window with server defaults");
assert.deepEqual(liveSetup("vi", tools, "", { keep: true, handle: "h1" }).sessionResumption, { handle: "h1" }, "handle resumes");
assert.ok(!("sessionResumption" in liveSetup("vi", tools, "", { handle: "h1" })), "a handle without keep is ignored");
assert.deepEqual(liveSetup("vi", tools, "", { model: "models/gemini-3.8-live-extended-thinking" }).thinkingConfig, { thinkingLevel: "LOW" }, "extended-thinking needs a level");
assert.ok(!("thinkingConfig" in liveSetup("vi", tools, "", { model: "models/gemini-3.8-live" })), "other models: no thinkingConfig");
